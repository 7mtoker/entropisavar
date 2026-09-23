# Behaviour contract: Entropisavar site

Target:       `index.html` served over http from this folder, opened in headless
              Edge/Chrome (real GPU via ANGLE, below-normal priority) at 1280x800 and
              390x844; also opened from `file://`.
Build:        the e2e harness prints the SHA-256 of every file it served; the page
              exposes `ES.build`, which must equal the `BUILD` constant in
              `js/app.js` on disk (read back over CDP).
Fixtures:     control values set through the page's own inputs (sliders, buttons).
Out of scope: real form delivery (the page is a demo and says so), frame rates
              (reported, not gated: headless screenshots stall the compositor).

## Clauses

C1.  The page loads with no uncaught exception and no console error.
C2.  The page references no external file of any kind and no bitmap, font, audio
     or video asset; every script and stylesheet is local.
C3.  The air hero shows a moving picture: two screenshots 1 s apart differ, and
     neither is flat.
C4.  Switching the air view to "Termal" changes the hero to a false-colour image
     (many more saturated hues than the visible view).
C5.  The fire chamber shows flame-coloured light once lit.
C6.  With the air shutter open (lean, phi <= 0.9) the flame is blue-dominant;
     closed (rich, phi >= 2.4) it is yellow/orange-dominant. The same control
     moves the colour, nothing else is changed.
C7.  The dew point shown for 22 °C / 75 % RH reads 17.4 °C (Magnus, source of truth
     `physics.dewPoint`), and changing RH to 45 % changes it to 9.5 °C.
C8.  With single glazing at -2 °C outside the status reads condensation; switching to
     triple glazing flips it to drying.
C9.  The glass visibly fogs over time under condensation and clears under drying
     (mean screenshot haze moves in the stated direction).
C10. The cooling-load calculator shows the BTU/h that `physics.coolingLoad` gives for
     the same inputs, and changing people count moves it.
C11. At 390 px width nothing scrolls horizontally.
C12. Submitting the contact form does not navigate or send anything; it shows an
     on-page reply that says it is a demo.

## Anti-cheat probes

P1. Vary a fixture (RH, phi, glazing) and confirm the clause's observation moves with it.
P2. Screenshot twice; animation clauses need a difference, not a single frame.
P3. Empty form submit: the page asks for the missing field instead of "sending".
P5. The flame colour is measured from pixels, not from the status label.
P6. `ES.build` in the page equals the `BUILD` constant read from `js/app.js` on disk.
