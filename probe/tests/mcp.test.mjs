import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHttpMcpFixture } from '../dist/src/mcp-fixture.js';

for (const kind of ['stdio','http','sse']) test(`MCP ${kind} fixture completes negotiation, discovery and tool call with SDK client`, {timeout:15000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acp-mcp-test-')), marker=join(dir,'events.jsonl');
  const fixture=kind==='stdio'?null:await startHttpMcpFixture(kind);
  const transport=kind==='stdio'?new StdioClientTransport({command:process.execPath,args:[resolve(import.meta.dirname,'../dist/fixtures/mcp-server.js')],env:{MCP_MARKER:marker}}):kind==='http'?new StreamableHTTPClientTransport(new URL(fixture.config.url)):new SSEClientTransport(new URL(fixture.config.url));
  const client=new Client({name:'fixture-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    const tools=await client.listTools();assert.equal(tools.tools[0].name,'probe_noop');
    const result=await client.callTool({name:'probe_noop',arguments:{}});assert.equal(result.isError,false);assert.match(result.content[0].text,/CANARY-7729/);
    await assert.rejects(client.callTool({name:'wrong_tool',arguments:{}}));
    const events=fixture?.events??readFileSync(marker,'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e=>e.event==='initialized'));assert.equal(events.filter(e=>e.event==='tools/call').length,1);
    if(fixture){const response=await fetch(fixture.config.url,{headers:{Origin:'https://unrelated.example'}});assert.equal(response.status,403);}
  } finally { await client.close();await fixture?.close();rmSync(dir,{recursive:true,force:true}); }
});
