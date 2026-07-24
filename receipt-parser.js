// Turns a receipt photo into structured line items using Claude's vision model.
// Falls back gracefully: if ANTHROPIC_API_KEY isn't set, parsing is "disabled"
// and the app lets the user type line items in by hand instead.

const MODEL = process.env.HOUSECART_PARSE_MODEL || 'claude-haiku-4-5';

// Structured-output schema: every field required, no nullable unions (kept
// simple so it's reliably accepted). Unknowns come back as "" or 0.
const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    store: { type: 'string', description: 'Shop/店 name, or "" if not visible.' },
    currency: { type: 'string', description: 'Currency symbol or ISO code (e.g. "£", "$", "EUR"), or "".' },
    purchased_at: { type: 'string', description: 'Date on the receipt as YYYY-MM-DD, or "".' },
    total: { type: 'number', description: 'Grand total paid, or 0 if not visible.' },
    items: {
      type: 'array',
      description: 'One entry per purchased product line.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Product name as printed.' },
          price: { type: 'number', description: 'Line price for that product (0 if unreadable).' },
        },
        required: ['name', 'price'],
      },
    },
  },
  required: ['store', 'currency', 'purchased_at', 'total', 'items'],
};

const PROMPT = `You are reading a photo of a shopping receipt.
Extract each purchased product as a line item with its price.
Rules:
- Include only actual products. Do NOT include subtotal, tax/VAT, total, change,
  card/cash lines, loyalty points, or store address as items.
- If a discount applies to a product, keep the product's final price.
- Use the exact grand total for "total".
- If something isn't legible, use "" for text and 0 for a price rather than guessing wildly.
Return the structured data.`;

export function parsingEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function parseModel() {
  return MODEL;
}

// Returns { store, currency, purchased_at, total, items:[{name,price}] }.
export async function parseReceipt({ base64, mediaType }) {
  // Dynamic import so a missing SDK only disables this feature, not the server.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

  // Structured outputs guarantee parseable JSON. No thinking/effort params:
  // the default model (Haiku 4.5) doesn't accept them, and receipt reading is
  // a perception task that doesn't need them.
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: {
      format: { type: 'json_schema', schema: RECEIPT_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Model returned no structured output.');
  const data = JSON.parse(textBlock.text);

  // Normalise into a predictable shape.
  return {
    store: (data.store || '').trim(),
    currency: (data.currency || '').trim(),
    purchased_at: (data.purchased_at || '').trim(),
    total: Number(data.total) || 0,
    items: Array.isArray(data.items)
      ? data.items
          .map((it) => ({ name: (it.name || '').trim(), price: Number(it.price) || 0 }))
          .filter((it) => it.name)
      : [],
  };
}
