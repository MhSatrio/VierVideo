# VierVideo master prompt

Paste this to an AI when you ask it to write an HTML animation for VierVideo. It tells the AI how to write the page so that
VierVideo can find its text, shapes and parts in the studio, select them, and move or resize them.

## How VierVideo reads your HTML

- It opens the page in a hidden browser window and draws it one frame at a time, at the exact time of each frame. The
  preview and the MP4 use the same frames.
- In the studio the user clicks the picture. VierVideo finds what is under the pointer: an HTML element (by its place in the
  page, its id and its classes), or a part of a canvas (one drawing call on the canvas: a line, a fill, a text).
- Moves and resizes are stored in the project, not written into your HTML. Your job is to make every part findable.

## Size and time

- Design for the frame: 1080 × 1920 pixels for 9:16 (1920 × 1080 for 16:9, 1080 × 1080 for 1:1). Use fixed pixel sizes, a
  body with `margin: 0`, and `overflow: hidden`.
- Animate from time. VierVideo controls `requestAnimationFrame`, `setTimeout`, `setInterval`, `Date`, `performance.now()`
  and `Math.random()`, so the same time always gives the same picture. Write the picture as a function of the elapsed time
  `t` (in milliseconds), like `draw(t)`, so any frame can be drawn on its own.
- Do not use CSS `transition` or `animation` for motion. The browser runs those on its own clock, outside VierVideo's, so the
  video would not match the preview. Move things by changing their style or their drawing from `t`.
- Scenes: switch on `t` (`if (t < 6000) scene1(t); else if (t < 14000) scene2(t - 6000);`).

## Scenes: keep them apart (this is what makes a part movable in one scene only)

- Name every scene. Call `window.vvScene('stretching')` at the start of that scene's drawing, in every frame, and use a
  different name for each scene. Guard the call so it cannot break the page: `window.vvScene && vvScene('stretching')`.
  Call it inside the draw code, not at page load. Canvas parts then belong to their scene, and a move made in one scene
  cannot reach another.
- A scene draws only its own objects. Do not reuse an object across scenes, and do not morph one object into the next
  scene's object: a spring that becomes a bent spring in the next scene is two objects. Draw the second one again, with its
  own id (SVG) or as its own drawing calls under the new scene name.
- Clear what a scene no longer shows: stop drawing it (or fade it to alpha 0 by not drawing it), so that two scenes never
  show the same part at the same time.
- Element ids are unique across the whole animation, not only within a scene. A move of an HTML element applies to the
  element with that id and tag wherever it is in the page, at any time.
- Give each scene its own text. Text tells parts apart in the studio (with the scene name).

## Text

- Put each piece of text in its own element with an id and a class: `<h1 id="title" class="headline">FTIR</h1>`,
  `<p id="caption">…</p>`, `<span>`, `<div>`. The studio then selects that element, shows its text, and finds the line that
  names it in your code.
- Text on a canvas is fine too: call `fillText(text, x, y)` with `textAlign` (`left`, `center` or `right`) and
  `textBaseline` set before the call. VierVideo boxes the text as the browser measures it, so the box fits the letters.
- Keep one sentence in one element, unless you want its parts to move apart.

## Shapes and drawings

- For shapes you want to select on their own, use inline SVG with an id on each shape: `<circle id="atom-c">`,
  `<path id="spring">`, `<line id="bond">`.
- For drawings with many points (a wave, a spectrum, a grid of bars), use a canvas, and draw each object with its own call:
  one `beginPath()` … `stroke()` per curve, one `fillText()` per label, one `fillRect()` per bar, one `arc()` with `fill()`
  per circle. The studio selects each call as a part.
- Set the colour before each call (`fillStyle` / `strokeStyle` as `#rrggbb` or `rgb()`), and keep the same drawing order from
  frame to frame within a scene. A part is numbered by its order in the frame, so a changed order changes the numbers.
- A fade changes only the alpha of the colour, and the part is still the same part, so fades are fine.
- Do not use `Path2D` objects. The studio cannot see what they draw; use the path calls on the context instead.

## What must not happen

- No single element or canvas that covers the whole frame and holds everything. VierVideo does not move such an element,
  and does not pick the parts of a canvas that covers the frame. Put the artwork on separate elements or drawing calls.
- No files from outside the page: no `<link>` to the internet, no remote fonts or images, no `<iframe>`, no `<video>`, no
  `alert()`. Use the font families the page can name (for example `Jost, system-ui, sans-serif`) and inline or data-URI images.
- Nothing that depends on the window size, the mouse, or the keyboard.
- Page controls that must not appear in the video go in an element with `id="controls"` or `id="bar"`. VierVideo hides those.

## Elements added in the studio

- An element pasted into the studio as its own layer is drawn alone: without the page's stylesheet, and without its scripts
  (scripts are removed). So give such an element inline `style` attributes, and do not rely on classes or ids from the page.

## Check before you give the file to VierVideo

1. Every piece of text is in an element with an id (or is a canvas `fillText` call).
2. Every shape you want to select has an id (SVG) or its own drawing call (canvas).
3. Nothing moves by CSS `transition` or `animation`, and no timer, random number or date decides the picture: only `t` does.
4. The picture at any time `t` depends only on `t`.
5. Every scene calls `vvScene` with its own name, and no object is reused or morphed across scenes.
6. Element ids are unique across the whole document.
7. Nothing is loaded from outside the file, and nothing covers the whole frame as a single element.
