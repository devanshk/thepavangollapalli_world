# From Scratch

Eight working systems, written from first principles and running live in the browser. No
libraries, no images, no web fonts, no build step, no network requests.

| Room | What it is |
| --- | --- |
| **Light** | A progressive path tracer in a WebGL 2 fragment shader: GGX metal, Fresnel glass, next-event estimation with multiple importance sampling, a thin-lens camera. |
| **World** | A planet generated from any word: seeded noise on a sphere, biomes, clouds, atmosphere, city lights, and facts measured from the same terrain function. |
| **Flow** | A Navier–Stokes fluid solver on the GPU, with an ink mode and a wind tunnel. |
| **Motion** | A 2D rigid-body physics engine: SAT collision, sequential impulses with warm starting, friction, joints, sleeping. |
| **Sound** | A generative composer and a synthesiser built on the Web Audio API. |
| **Language** | *Sable*, a small typed language, with a compiler that emits WebAssembly byte by byte, a reference interpreter, and a disassembler. |
| **Reason** | A computer algebra system: exact arithmetic, differentiation with steps, integration, factoring, series, equation solving, typeset output, and numerical self-checks. |
| **Learning** | A neural network, with hand-written backpropagation, that learns a picture while you watch. |

The page also carries its own proof: press **Run all tests** and every exhibit's test suite runs
in your browser, against the code you just used.

## Run it

It is a static site. Serve the repository root with anything:

```sh
node tools/serve.mjs          # http://127.0.0.1:4173
```

To publish it with GitHub Pages, point Pages at the root of this branch. Every URL in the site is
relative, so it works from any base path.

## Check it

```sh
node tools/test.mjs               # every exhibit's tests, in Node
node tools/test.mjs reason -v     # one exhibit, listing each test
node tools/browser-test.mjs       # the assembled site in headless Chromium (needs Playwright)
node tools/browser-test.mjs --mobile
```

`browser-test.mjs` scrolls to every room so it mounts and runs, presses "Run all tests", and
fails on any console error, failed request, request to another origin, horizontal overflow, or
failing test.

## How it is put together

```
index.html                 the page
assets/css/tokens.css      design tokens every exhibit draws from
assets/css/kit.css         the shared controls
assets/css/site.css        the page shell
assets/js/kit.js           canvas, input, controls and animation helpers
assets/js/glkit.js         a thin WebGL 2 layer
assets/js/check.js         a test micro-framework that runs in Node and in the browser
assets/js/main.js          mounts each exhibit when it is near, runs it only while visible
exhibits/<room>/           one self-contained ES module per room, with its own tests.js
exhibits/README.md         the contract between the page and an exhibit
tools/                     static server, test runners, screenshots, stats
```

Each exhibit keeps its logic in pure modules with no DOM access, which is what makes the same
tests runnable in both places. `exhibits/_example/` is the smallest exhibit that follows the
contract.

## How it was made

This repository was written by Claude Fable 5.2, an AI model made by Anthropic, in one session,
from a two-sentence brief: *"Clear all data in this repo and start fresh. Build me a site showing
the most impressive demo of Fable 5.2 capabilities that you can."* The page's own "How this was
made" section gives the account, including what was not verified.
