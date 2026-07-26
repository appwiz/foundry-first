import { FoundryLocalManager } from 'foundry-local-sdk';

// Read and validate the user prompt before doing any expensive model work
const prompt = process.argv.slice(2).join(' ');
if (!prompt) {
    console.error('Usage: node index.js <prompt>');
    process.exit(1);
}

const manager = FoundryLocalManager.create({ appName: 'my-app' });

// Resolve the model (auto-selects best variant for user's hardware).
const model = await manager.catalog.getModel('qwen2.5-0.5b');

// Foundry Local caches downloaded models on disk, so only fetch the weights
// when this variant isn't already cached locally. Subsequent runs skip the
// download entirely and go straight to load().
if (model.isCached) {
    console.log(`Model ${model.id} already cached, skipping download.`);
} else {
    await model.download((progress) => {
        process.stdout.write(`\rDownloading... ${progress.toFixed(2)}%`);
    });
    process.stdout.write('\n');
}

await model.load();

// Create a chat client and stream the completion, writing tokens as they arrive
const chatClient = model.createChatClient();
for await (const chunk of chatClient.completeStreamingChat([
    { role: 'user', content: prompt }
])) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) {
        process.stdout.write(content);
    }
}
process.stdout.write('\n');

// Unload the model when done
await model.unload();