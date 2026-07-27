# Day 1 — LinkedIn post

**Article:** An LLM on your laptop, in 40 lines

---

A language model answered my question in under a second, for free, with the network unplugged.

It's running inside my Node process. Not a container, not a localhost server — the model weights are loaded into the same process memory as my application code.

That surprised me. Most local-LLM tooling runs a daemon on a port and you talk HTTP to it. Microsoft Foundry Local loads a native addon directly into your process and calls into it over FFI. No port, no base URL, nothing to supervise. When your process exits, the model goes with it.

The whole program is about 40 lines: resolve a model name to a build that suits your hardware, download it if you don't have it, load, infer, unload.

Three things cost me an hour each, so here they are free:

→ The package you install isn't the package you import. `foundry-local-sdk-winml` contains no API at all — it's an installer wrapper that fetches a different native runtime. You install one, you import the other. It looks like a bug for as long as it takes to find the install script.

→ `create()` has no `await` and that's correct. It returns synchronously and blocks while initialising. There's an async variant when blocking matters.

→ Native libraries can't be copied between machines. Wrong platform gives you "FoundryLocalCorePath not specified", which is an unhelpful way to say "wrong architecture". Delete node_modules and reinstall — never hand-copy the DLLs.

So: it works. It's also frequently wrong.

Asked which amendment introduced Iceland's transferable fishing quotas, my 0.5B model confidently cited "Article 247-5-1". There is no Article 247-5-1. It invented it in a fluent, authoritative sentence with no hint it was guessing.

That's the interesting problem, and it's what the next six days are about: how do you tell — before you show anyone the answer — whether a small model actually knew what it was talking about?

Day 1 of 7: [LINK]

#LocalLLM #EdgeAI #SoftwareEngineering #AI
