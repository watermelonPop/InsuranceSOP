import { getLLMClient } from "./index.js";

async function main() {
  const client = getLLMClient();
  const reply = await client.complete({
    system: "You are a terse test responder. Reply with exactly one short sentence.",
    messages: [{ role: "user", content: "Say hello and confirm you are working." }]
  });
  console.log("LLM reply:", reply);
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
