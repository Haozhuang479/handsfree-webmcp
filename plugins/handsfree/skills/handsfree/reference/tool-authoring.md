# Authoring WebMCP tools for handsfree

## The draft, precisely (webmachinelearning.github.io/webmcp, Sept 2026)
- `document.modelContext` (SecureContext). Methods: `registerTool(tool, {signal, exposedTo})` → `Promise<undefined>`, `getTools({fromOrigins})` → `Promise<RegisteredTool[]>`, `executeTool(tool, input, {signal})` → `Promise<DOMString>` (result JSON-serialised). Event: `toolchange`. There is **no** `unregisterTool` — abort the `signal` you registered with.
- Tool: `name` (1–128 chars `[A-Za-z0-9_.-]`), `description`, `execute(inputObject, {signal})` required; `title`, `inputSchema`, `annotations {readOnlyHint, untrustedContentHint}` optional. `execute` may return any JSON-serialisable value.
- Anything else (MCP hints, `handsfree.*`) is an extension: fine on the page-side registry, stripped before forwarding to a native implementation.

## The shape
```js
document.modelContext.registerTool({
  name: 'search_products',                       // snake_case verbs; runtime turns it into a spoken alias
  description: 'Search the catalog with a natural-language query and render the results grid.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, max_price: { type: 'number' } }, required: ['query'] },
  annotations: { readOnlyHint: true, handsfree: { role: 'text-sink', phrases: ['search for', 'find', 'show me'] } },
  async execute(input) { const out = await app.search(input); return { returned: out.length }; },
});
```
`name`, `description`, `inputSchema`, `execute` are WebMCP. `annotations.readOnlyHint` / `untrustedContentHint` are the draft's; other MCP hints are extensions. `annotations.handsfree` is this runtime's extension — unknown
annotations are ignored by browsers.

## handsfree annotations
| key | meaning |
|---|---|
| `role: 'text-sink'` | free-form transcript is passed to this tool's first string prop (exactly one tool) |
| `role: 'scroll'` | swipe gestures and "scroll …" go here as `{direction}` |
| `phrases: [...]` | spoken aliases; the remainder of the utterance becomes the first string prop / `target` |
| `confirm: true` | runtime says "say yes to …" and waits for yes/no before executing |

## How the runtime fills inputs (no LLM)
- `target` prop → `next` / `prev` / `first` / `last` / a number (words or digits) / leftover text.
- `direction` prop → `up` / `top` / `bottom` else `down`.
- Any `enum` prop → first enum value that appears in the utterance.
- `max_price` → "under $50" → `50`.
- First string prop → leftover text after the matched phrase.
So keep tool inputs flat, named like the table above, and give enum values
natural words.

## Shim when the page has no registry (copy from the demo's `webmcp.js`)
The page cannot enumerate what it registered with native WebMCP, so keep a
page-side list. Pattern: `window.WebMCP = {registerTool, listTools, callTool,
events}`, forward to native `document.modelContext` if it exists and is not a
polyfill (`!document.modelContext.polyfill`), otherwise define
`document.modelContext` yourself. Emit `webmcp:toolcall` / `webmcp:toolresult`
events so a trace panel or test can observe calls.

## Return values
Return small structured objects; the runtime speaks short feedback from
`focused`, `title`, `returned`, `count`, `opened`, `loaded`. Do not return DOM
nodes or huge arrays.

## Framework notes
- **Static / Vite / CRA:** one `webmcp-tools.js` loaded after the app is
  ready; call `App.*` functions directly.
- **React/Next:** register in a `useEffect` in the root layout client
  component; unregister on unmount (`registerTool` returns an unregister fn
  in the shim). Put `handsfree.js` in `public/`, load with
  `<Script strategy="beforeInteractive">`.
- **Vue/Nuxt:** a client-only plugin (`plugins/webmcp.client.js`).
- **Shopify theme:** `layout/theme.liquid` head; tools call Storefront
  `/cart/add.js`, `/search/suggest.json`, section rendering — no fake clicks.
- **Routing:** if the app has a router, tools should push history like a click
  would, so voice actions are shareable URLs.
