// MCP over Streamable HTTP.
//
// A contributor's Claude Code is configured by the `.mcp.json` committed in
// this repo, so cloning the project is the whole setup. Authentication is the
// same per-person bearer token everything else uses -- the answer to "an agent
// cannot get in" must never be "paste the password into a chat".
//
// claude.ai and mobile need OAuth 2.1 + DCR on top of this. That front door is
// already written in ctfg-directory/ops-mcp-worker; extract it, do not rebuild.

import { viewEnv } from './band.js';
import { flag } from './flag.js';
import { canRead } from './identity.js';

const TOOLS = [
  { name: 'list_documents', description: 'Every document in this project, with its sections.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_document', description: 'The markdown source of one document, as a contributor would edit it.', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
  { name: 'list_questions', description: 'The question catalog with its answers. Filter by open and audience.', inputSchema: { type: 'object', properties: { open: { type: 'boolean' }, audience: { type: 'string' } } } },
  { name: 'read_question', description: 'One question, its provenance, and every answer with edit history.', inputSchema: { type: 'object', properties: { number: { type: 'number' }, slug: { type: 'string' } } } },
  { name: 'post_answer', description: 'Answer a question as the authenticated person. Say what you are posting first.', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, body: { type: 'string' } }, required: ['slug', 'body'] } },
  { name: 'list_comments', description: 'What users have said unprompted, newest last. Read this before deciding what to work on.', inputSchema: { type: 'object', properties: { doc: { type: 'string' }, since: { type: 'string' } } } },
  { name: 'reply_to_comment', description: 'Reply to a comment as the authenticated person.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } }, required: ['id', 'body'] } },
  { name: 'get_design_tokens', description: 'This project’s design system, so generated interface is on-system.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_chat_sessions', description: 'Who asked the assistant what, newest first. A recurring question here is a question that belongs in the catalog.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_chat_session', description: 'One conversation in full.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_activity', description: 'The activity feed and the decision log: what happened, and what was decided and why.', inputSchema: { type: 'object', properties: {} } },
];

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });

async function asset(env, request, path) {
  if (!env.ASSETS) return null;
  // A Request, not a bare URL: the binding accepts both, and passing the same
  // thing in tests and in production is worth more than the shorter line.
  const r = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  return r.ok ? r : null;
}

async function manifest(env, request) {
  const r = await asset(env, request, '/manifest.json');
  return r ? r.json() : null;
}

async function answersFor(env, ids) {
  if (!ids.length) return {};
  const marks = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, question_id, author_name, body, created_at, updated_at, revision_count
       FROM answers WHERE question_id IN (${marks}) ORDER BY created_at`
  ).bind(...ids).all();
  const out = {};
  for (const r of results || []) (out[r.question_id] ||= []).push(r);
  return out;
}

async function call(name, args, env, request, me, handlers) {
  const m = await manifest(env, request);
  if (!m) return text('The build manifest is not available. Has the site been built and deployed?');

  const find = (q) => m.questions.find((x) => x.slug === q.slug || x.number === q.number);

  switch (name) {
    case 'list_documents':
      return text(m.docs.map((d) => ({ slug: d.slug, title: d.title, type: d.type, sections: d.headings.filter((h) => h.id).map((h) => h.id) })));

    case 'read_document': {
      const doc = m.docs.find((d) => d.slug === args.slug);
      if (!doc) return text(`No document "${args.slug}". Use list_documents.`);
      const r = await asset(env, request, `/source/${doc.source}`);
      return text(r ? await r.text() : `The source for "${args.slug}" is not served.`);
    }

    case 'list_questions': {
      let qs = m.questions.filter((q) => !q.hidden);
      if (args.open) qs = qs.filter((q) => !q.resolved);
      if (args.audience) qs = qs.filter((q) => q.audience === args.audience);
      const answers = await answersFor(env, qs.map((q) => q.id));
      return text(qs.map((q) => ({
        number: q.number, slug: q.slug, audience: q.audience, group: q.group, asked: q.asked,
        document: q.doc, section: q.section, resolved: q.resolved || null,
        question: q.body.replace(/<[^>]+>/g, '').trim(),
        why_asked: q.why ? q.why.replace(/<[^>]+>/g, '').trim() : null,
        answers: (answers[q.id] || []).map((a) => ({ by: a.author_name, at: a.created_at, body: a.body, edits: a.revision_count })),
      })));
    }

    case 'read_question': {
      const q = find(args);
      if (!q) return text('No such question. Use list_questions.');
      const answers = await answersFor(env, [q.id]);
      return text({ ...q, body: q.body.replace(/<[^>]+>/g, '').trim(), answers: answers[q.id] || [] });
    }

    case 'post_answer': {
      if (!me.can_write) return text('Not permitted: this token cannot write.');
      const q = find({ slug: args.slug });
      if (!q) return text(`No question "${args.slug}".`);
      const r = await handlers.postAnswer(q.id, args.body, env, me);
      return text(r.ok ? `Posted as ${me.name} against Q${q.number}.` : `Not posted: ${r.error}`);
    }

    case 'list_comments': {
      const r = await handlers.listComments(env, args.doc, args.since);
      return text(r);
    }

    case 'reply_to_comment': {
      if (!me.can_write) return text('Not permitted: this token cannot write.');
      const r = await handlers.replyToComment(args.id, args.body, env, me);
      return text(r.ok ? `Replied as ${me.name}.` : `Not posted: ${r.error}`);
    }

    case 'get_design_tokens': {
      const r = await asset(env, request, '/tokens.css');
      return text(r ? await r.text() : 'No tokens served.');
    }

    case 'list_chat_sessions': {
      const r = await handlers.listChatSessions(env, me);
      return text(r);
    }

    case 'read_chat_session': {
      const r = await handlers.readChatSession(env, me, args.id);
      return text(r);
    }

    case 'list_activity':
      return text(m.docs.filter((d) => d.type === 'post' || d.type === 'decision')
        .map((d) => ({ type: d.type, date: d.date, title: d.title, slug: d.slug })));

    default:
      return text(`No tool named "${name}".`);
  }
}

export async function handleMcp(request, env, me, handlers) {
  // ⚠️ Both doors (/mcp and /connect) arrive here, so this is where MCP reads
  // through the viewer's path (band.js viewEnv): members-only content is gone
  // before any tool sees the manifest.
  env = viewEnv(request, env, me);
  try {
    return await dispatch(request, env, me, handlers);
  } catch (e) {
    // A thrown error became an opaque 500 at the client, which reports it as
    // "the MCP server returned an error" and names nothing. Say what broke.
    console.error(`[mcp] ${e.message}`);
    return new Response(JSON.stringify({
      jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message },
    }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}

async function dispatch(request, env, me, handlers) {
  const body = await request.json().catch(() => null);
  if (!body || body.jsonrpc !== '2.0') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a JSON-RPC request' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });

  if (body.method === 'initialize') {
    // ⚠️ Echo the version the client asked for. Answering with a fixed one that
    // a newer client did not offer is a negotiation failure, and the client
    // reports it as "the MCP server returned an error" with nothing about why.
    const asked = body.params?.protocolVersion;
    return reply({
      protocolVersion: asked || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'collab-site', version: '0.1.0' },
    });
  }

  // Some clients send these during setup. Answering "no method" to a ping is a
  // connection failure for something the server simply does not have.
  if (body.method === 'ping') return reply({});
  if (body.method === 'resources/list') return reply({ resources: [] });
  if (body.method === 'prompts/list') return reply({ prompts: [] });
  if (String(body.method || '').startsWith('notifications/')) return new Response(null, { status: 202 });

  if (body.method === 'tools/list') return reply({ tools: TOOLS });

  if (body.method === 'tools/call') {
    // A token that resolves to nobody must not read a private project.
    // ⚠️ The same `canRead` the page branch and /api/ use. This door had the
    // rule right and the other two disagreed; one function is now the only
    // place it can be wrong.
    if (!canRead(env, me)) {
      return reply({ ...text('Not authenticated. Set a bearer token for this project.'), isError: true });
    }
    const result = await call(body.params?.name, body.params?.arguments || {}, env, request, me, handlers);
    return reply(result);
  }

  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `no method ${body.method}` } }), { status: 400, headers: { 'content-type': 'application/json' } });
}

export { TOOLS };
