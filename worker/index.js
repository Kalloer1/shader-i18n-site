/**
 * Cloudflare Worker: 光影汉化请求代理
 *
 * 接收前端表单提交 → 写入腾讯文档智能表格
 *
 * 环境变量（Worker Secrets）：
 * - TENCENT_DOCS_TOKEN: 腾讯文档 API token
 *
 * 智能表格信息：
 * - file_id: BpuvvJhOQHbW
 * - sheet_id: t00i2h
 * - 访问链接: https://docs.qq.com/smartsheet/DQnB1dnZKaE9RSGJX
 */

const TENCENT_MCP_URL = 'https://docs.qq.com/openapi/mcp';
const FILE_ID = 'BpuvvJhOQHbW';
const SHEET_ID = 't00i2h';

// CORS 配置
const ALLOWED_ORIGINS = [
  'https://shader-i18n-site.pages.dev',
  'http://localhost:5173',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 只接受 POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    try {
      const body = await request.json();
      const { name, url, contact, note } = body;

      // 验证必填字段
      if (!name || !url) {
        return new Response(JSON.stringify({ error: '光影名称和 Modrinth 链接为必填' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      // 验证 URL 格式
      if (!url.startsWith('https://modrinth.com/')) {
        return new Response(JSON.stringify({ error: '请填写有效的 Modrinth 链接' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      // 构建字段值
      const fieldValues = [
        {
          field: '光影名称',
          text_value: { items: [{ text: name, type: 'text' }] },
        },
        {
          field: 'Modrinth 链接',
          url_value: { items: [{ text: name, type: 'url', link: url }] },
        },
        {
          field: '来源',
          option_value: { items: [{ text: '玩家请求' }] },
        },
        {
          field: '状态',
          option_value: { items: [{ text: '待翻译' }] },
        },
        {
          field: '提交时间',
          string_value: String(Date.now()),
        },
      ];

      // 可选字段
      if (contact) {
        fieldValues.push({
          field: '联系方式',
          text_value: { items: [{ text: contact, type: 'text' }] },
        });
      }
      if (note) {
        fieldValues.push({
          field: '备注',
          text_value: { items: [{ text: note, type: 'text' }] },
        });
      }

      // 调用腾讯文档 MCP API
      const token = env.TENCENT_DOCS_TOKEN;
      if (!token) {
        return new Response(JSON.stringify({ error: '服务配置错误：缺少 token' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      const mcpResponse = await fetch(TENCENT_MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'smartsheet.add_records',
          params: {
            file_id: FILE_ID,
            sheet_id: SHEET_ID,
            records: [{ field_values: fieldValues }],
          },
          id: 1,
        }),
      });

      const mcpResult = await mcpResponse.json();

      if (mcpResult.error) {
        console.error('Tencent Docs API error:', mcpResult);
        return new Response(JSON.stringify({ error: '提交失败，请稍后重试', detail: mcpResult.error }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      return new Response(JSON.stringify({ success: true, message: '提交成功！我们会尽快处理你的请求。' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });

    } catch (err) {
      console.error('Worker error:', err);
      return new Response(JSON.stringify({ error: '服务器内部错误' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  },
};
