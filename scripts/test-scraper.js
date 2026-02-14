/* eslint-disable no-console */

const providerEnv = [
  ["chatgpt", "BRIGHT_DATA_DATASET_CHATGPT"],
  ["perplexity", "BRIGHT_DATA_DATASET_PERPLEXITY"],
  ["copilot", "BRIGHT_DATA_DATASET_COPILOT"],
  ["gemini", "BRIGHT_DATA_DATASET_GEMINI"],
  ["google_ai", "BRIGHT_DATA_DATASET_GOOGLE_AI"],
  ["grok", "BRIGHT_DATA_DATASET_GROK"],
];

const providerBaseUrl = {
  chatgpt: "https://chatgpt.com/",
  perplexity: "https://www.perplexity.ai/",
  copilot: "https://copilot.microsoft.com/",
  gemini: "https://gemini.google.com/",
  google_ai: "https://www.google.com/",
  grok: "https://grok.com/",
};

function chooseProvider() {
  for (const [provider, envName] of providerEnv) {
    if (process.env[envName]) {
      return { provider, datasetId: process.env[envName] };
    }
  }
  return null;
}

async function run() {
  const apiKey = process.env.BRIGHT_DATA_KEY;
  const selected = chooseProvider();

  if (!apiKey || !selected) {
    const mock = {
      mode: "mock",
      message:
        "No BRIGHT_DATA_KEY and provider dataset ID found. Set .env values to run live scraper test.",
      sample: {
        answer: "Mock response: Sovereign AEO Tracker scraper pipeline is wired.",
        sources: ["https://docs.brightdata.com/datasets/scrapers/scrapers-library/ai-scrapers"],
      },
    };
    console.log(JSON.stringify(mock, null, 2));
    return;
  }

  const query = {
    input: [
      {
        url: providerBaseUrl[selected.provider],
        prompt:
          "What are the top 3 ranking factors for AI answer engine visibility in 2026? Include sources.",
        index: 1,
      },
    ],
  };

  const scrapeRes = await fetch(
    `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${selected.datasetId}&notify=false&include_errors=true&format=json`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(query),
    },
  );

  if (!scrapeRes.ok) {
    const text = await scrapeRes.text();
    throw new Error(`Scrape request failed (${scrapeRes.status}): ${text}`);
  }

  const data = await scrapeRes.json();
  console.log(
    JSON.stringify(
      {
        mode: "live",
        provider: selected.provider,
        records: Array.isArray(data) ? data.length : 1,
        preview: Array.isArray(data) ? data[0] : data,
      },
      null,
      2,
    ),
  );
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
