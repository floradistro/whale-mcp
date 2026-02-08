# @swagmanager/mcp

MCP (Model Context Protocol) server for SwagManager — manage inventory, orders, analytics, customers, and more from Claude Code or Claude Desktop.

## Setup

```bash
npm install -g @swagmanager/mcp
```

### Environment Variables

Create a `.env` file or set these environment variables:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DEFAULT_STORE_ID=your-store-uuid
```

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "swagmanager": {
      "command": "swagmanager-mcp",
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your-key",
        "DEFAULT_STORE_ID": "your-store-uuid"
      }
    }
  }
}
```

### Claude Desktop

Add to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "swagmanager": {
      "command": "npx",
      "args": ["@swagmanager/mcp"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your-key",
        "DEFAULT_STORE_ID": "your-store-uuid"
      }
    }
  }
}
```

## Tools

Tools are loaded dynamically from the `ai_tool_registry` database table. The default set includes:

| Tool | Description |
|------|-------------|
| `analytics` | Sales analytics with flexible date ranges |
| `inventory` | Adjust quantities, set stock, transfer between locations |
| `inventory_query` | Query inventory summary, velocity, by location |
| `inventory_audit` | Start, count, complete inventory audits |
| `orders` | Find orders, get details, purchase orders |
| `purchase_orders` | Create, approve, receive, cancel purchase orders |
| `transfers` | Transfer inventory between locations |
| `products` | Find, create, update products and pricing |
| `customers` | Find, create, update customers |
| `collections` | Manage product collections |
| `suppliers` | Find and list suppliers |
| `locations` | Find store locations |
| `email` | Send emails, manage inbox |
| `alerts` | Low stock and pending order alerts |
| `documents` | Generate COAs and documents |
| `audit_trail` | View audit logs |

## Development

```bash
git clone https://github.com/floradistro/whale-mcp.git
cd whale-mcp
npm install
cp .env.example .env  # fill in your credentials
npm run dev
```

## License

MIT
