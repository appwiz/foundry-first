# Day 1: An LLM on your laptop, in 40 lines

*Part 1 of 7 on building a local-first LLM router.*

Every LLM tutorial starts the same way: get an API key, install a client, send a request to someone else's datacentre. That's a fine way to build things. But it means every question your app answers costs money, adds latency, and leaves the building.

There's another option that has quietly become practical: run the model on the machine you already have.

Over the next seven days I'm going to build a command-line tool that answers questions with a small model running locally, and only calls out to a frontier model when the local one is measurably unsure. The interesting part isn't the plumbing — it's the word *measurably*, and how much trouble that one word causes.

Today, the plumbing.

## What "local" actually means here

I'm using [Microsoft Foundry Local](https://learn.microsoft.com/azure/ai-foundry/foundry-local/), which packages the awkward parts of on-device inference: getting model weights in the right format, picking an execution provider that suits your hardware, and managing the runtime's memory.

The thing that surprised me is that it isn't a server.

Most local-LLM tooling — Ollama, llama.cpp's server mode, LM Studio — runs a daemon on a port and you talk HTTP to it. Foundry Local's SDK loads a **native addon directly into your Node process** and calls into it over FFI:

```
your code
  └─ foundry-local-sdk (JavaScript)
       └─ native addon  ← FFI boundary
            └─ Microsoft.AI.Foundry.Local.Core.dll
                 └─ onnxruntime-genai.dll
                      └─ onnxruntime.dll
                           └─ CPU / GPU / NPU
```

The model lives in *your* process's memory. There's no port, no base URL, no daemon to start or supervise. When your process exits, the model is gone with it.

That's a genuine architectural difference, not a detail. It means no serialization hop on every token, no separate thing to install and keep running — and also that a 900 MB model is 900 MB of *your* process's resident memory, which is a tradeoff you should make deliberately.

## The whole program

Here's the shape of it, minus the licence header:

```js
import { FoundryLocalManager } from 'foundry-local-sdk';

const prompt = process.argv.slice(2).join(' ');
if (!prompt) {
    console.error('Usage: node index.js <prompt>');
    process.exit(1);
}

const manager = FoundryLocalManager.create({ appName: 'my-app' });

// Alias → the concrete build best suited to this machine
const model = await manager.catalog.getModel('qwen2.5-0.5b');

if (model.isCached) {
    console.log(`Model ${model.id} already cached, skipping download.`);
} else {
    await model.download((progress) => {
        process.stdout.write(`\rDownloading... ${progress.toFixed(2)}%`);
    });
    process.stdout.write('\n');
}

await model.load();

const chatClient = model.createChatClient();
const response = await chatClient.completeChat([
    { role: 'user', content: prompt }
]);

console.log(response.choices[0]?.message?.content);

await model.unload();
```

Run it:

```console
$ node index.js "What is the capital of France?"
Model qwen2.5-0.5b-instruct-generic-cpu:4 already cached, skipping download.
Paris.
```

That's a language model answering a question, on my laptop, with the network unplugged. The first run downloads about 840 MB of weights; every run after that starts in under a second.

The lifecycle is worth reading as a sequence, because it's the same everywhere in this space: **resolve** a friendly name to a concrete build, **download** if you don't have it, **load** into memory, **infer**, **unload**.

Note that `getModel('qwen2.5-0.5b')` returns a *variant* — on my machine, `qwen2.5-0.5b-instruct-generic-cpu:4`. The catalog picks the build that fits the hardware it finds. Ask for the same alias on a machine with a supported GPU and you get a different artifact.

## Three things that will trip you up

I hit all three. They're the kind of thing that costs an hour if nobody warns you.

**1. The package you install isn't the package you import.**

My `package.json` depends on `foundry-local-sdk-winml`. My code imports `foundry-local-sdk`. That looks like a bug and it isn't.

The `-winml` package contains no API at all. It's an installer wrapper: it declares the base SDK as its own dependency, and its install script fetches the **Windows ML** build of the native runtime instead of the standard one. So you install the variant, and you import the base package. The two coordinate through a filesystem check — the base SDK's install script looks for a sibling `-winml` directory and steps aside if it finds one.

If you "fix" this by changing the import, nothing works. I've since written a comment in the repo shouting about it.

**2. `create()` looks like it's missing an `await`.**

```js
const manager = FoundryLocalManager.create({ appName: 'my-app' });  // no await
```

That's correct. `create()` returns the manager synchronously and blocks the event loop while it initialises. There's a `createAsync()` for when blocking matters — a server, a GUI — but for a CLI that has nothing else to do, the blocking version keeps the code linear.

**3. Native libraries can't be copied between machines.**

They live in `node_modules/foundry-local-sdk/foundry-local-core/<platform>-<arch>/`. On my Windows x64 box that's five DLLs. If that directory is empty or holds another platform's binaries, you get `FoundryLocalCorePath not specified` — which is an unhelpful way of saying "wrong platform".

The fix is always to delete `node_modules` and reinstall so platform detection re-runs. Never hand-copy DLLs into place; you'll get a subtler failure later.

The corollary: don't commit `node_modules` for a project like this, and don't ship it in a Docker layer built on a different architecture.

## `appName` is load-bearing

One small thing with outsized consequences:

```js
FoundryLocalManager.create({ appName: 'my-app' })
```

That string determines where everything lives — `%USERPROFILE%\.my-app\` for the model cache, the logs, and anything else the SDK persists. Change it later and you orphan your 840 MB cache and trigger a fresh download. Pick it once.

## So it works. Now the honest part.

I have a language model running locally, for free, offline. That's genuinely great.

It's also, quite often, wrong.

`qwen2.5-0.5b` has half a billion parameters. For scale, frontier models are three to four orders of magnitude larger. It'll tell you the capital of France without breaking a sweat. Ask it something obscure and it will answer with total confidence and completely invented facts. Here it is on a question about Icelandic fisheries law:

> The specific amendment to the Icelandic Fisheries Management Act of 1990 that introduced transferable quotas is **Article 247-5-1** of the Icelandic Act on the Development of the Fishing Industry.

There is no Article 247-5-1. It made it up, in a fluent and authoritative sentence, and offered no hint that it was guessing.

So a small local model is fast, free, private — and unreliable in a way that's hard to see from the outside. A frontier model is accurate, expensive, and requires a network round trip.

Picking one and living with the downside seems like the wrong answer. **Tomorrow I'll make the case for using both**, and run into the question that turns out to be the hard part of this entire project: how do you know, before you show the user anything, whether the local answer is any good?

---

*Next: [Day 2 — Why route between two models at all](day-2-why-route.md)*

*Code: [github.com/appwiz/foundry-first](https://github.com/appwiz/foundry-first)*
