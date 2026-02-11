/**
 * Server Tool Response Formatter
 *
 * Renders server tool results as clean, professional business documents.
 * Uses markdown tables, status badges, and structured layouts.
 *
 * Design principles:
 * - Lookup tools (locations, products/find, customers/find, suppliers)
 *   ALWAYS include the full UUID so the model can chain calls.
 * - Mutation confirmations show a rich detail card.
 * - Analytics/summaries use tables + charts.
 * - Everything is compact and human-readable.
 */

// ============================================================================
// HELPERS
// ============================================================================

function $(n: number | string | undefined | null): string {
  if (n === undefined || n === null) return "$0.00";
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "$0.00";
  const abs = Math.abs(v);
  const s = abs >= 1000
    ? "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "$" + abs.toFixed(2);
  return v < 0 ? "-" + s : s;
}

function n(v: number | string | undefined | null): string {
  if (v === undefined || v === null) return "0";
  const x = typeof v === "string" ? parseFloat(v) : v;
  return isNaN(x) ? "0" : x.toLocaleString("en-US");
}

function pct(v: number | string | undefined | null): string {
  if (v === undefined || v === null) return "0%";
  const s = String(v);
  if (s.endsWith("%")) return s;
  const x = parseFloat(s);
  return isNaN(x) ? "0%" : x.toFixed(1) + "%";
}

function date(s: string | undefined | null): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return String(s).slice(0, 10); }
}

function time(s: string | undefined | null): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return String(s).slice(0, 16); }
}

function badge(status: string | undefined): string {
  if (!status) return "";
  const s = status.toLowerCase().replace(/_/g, " ");
  if (["completed", "received", "approved", "active", "success", "published", "paid"].includes(s))
    return `\`✓ ${s}\``;
  if (["in transit", "shipped", "processing"].includes(s))
    return `\`◆ ${s}\``;
  if (["pending", "draft", "unfulfilled"].includes(s))
    return `\`○ ${s}\``;
  if (["cancelled", "failed", "rejected"].includes(s))
    return `\`✕ ${s}\``;
  return `\`${s}\``;
}

/** Key-value detail card — renders as bold key: value pairs */
function card(title: string, fields: [string, string][], footer?: string): string {
  const lines = [`**${title}**`, ""];
  const maxKey = Math.max(...fields.map(([k]) => k.length));
  for (const [key, value] of fields) {
    lines.push(`**${key.padEnd(maxKey)}**  ${value}`);
  }
  if (footer) lines.push("", footer);
  return lines.join("\n");
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  const sep = headers.map(() => "---").join(" | ");
  return `| ${headers.join(" | ")} |\n| ${sep} |\n${rows.map(r => "| " + r.join(" | ") + " |").join("\n")}`;
}

function chart(title: string, entries: [string, string][]): string {
  return "```chart\n" + title + "\n" + entries.map(([l, v]) => `${l}: ${v}`).join("\n") + "\n```";
}

/** Location display: "Name (City, ST)" */
function loc(l: any): string {
  if (!l) return "—";
  if (typeof l === "string") return l;
  const parts = [l.name];
  if (l.city && l.state) parts.push(`${l.city}, ${l.state}`);
  else if (l.city) parts.push(l.city);
  return parts.length > 1 ? `${parts[0]} (${parts[1]})` : parts[0] || "—";
}

// ============================================================================
// FORMATTERS
// ============================================================================

type Fmt = (data: any, input: Record<string, unknown>) => string | null;

// ── LOCATIONS (lookup — always include UUID) ──

const fmtLocations: Fmt = (data) => {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) return "**Locations** — none found";

  return [
    `**Locations** — ${items.length} found`,
    "",
    table(
      ["ID", "Name", "Address", "Status"],
      items.map((l: any) => [
        `\`${l.id}\``,
        l.name || "—",
        [l.city, l.state].filter(Boolean).join(", ") || "—",
        badge(l.is_active !== false ? "active" : "inactive"),
      ])
    ),
  ].join("\n");
};

// ── PRODUCTS ──

const fmtProducts: Fmt = (data, input) => {
  const action = input.action as string;

  if (action === "find") {
    // Lookup — always include UUID for chaining
    const items = Array.isArray(data) ? data : (data.data || data.products || []);
    if (!Array.isArray(items) || items.length === 0) return "**Products** — none found";

    return [
      `**Products** — ${items.length} found`,
      "",
      table(
        ["ID", "Name", "SKU", "Category", "Stock", "Status"],
        items.slice(0, 20).map((p: any) => [
          `\`${p.id}\``,
          p.name || "—",
          p.sku ? `\`${p.sku}\`` : "—",
          p.category_name || p.category || "—",
          p.total_stock !== undefined ? n(p.total_stock) : "—",
          badge(p.status),
        ])
      ),
    ].join("\n");
  }

  if (action === "create") {
    return card("Product Created", [
      ["Name", data.name || "—"],
      ["SKU", data.sku ? `\`${data.sku}\`` : "—"],
      ["ID", `\`${data.id}\``],
    ]);
  }

  if (action === "update") {
    return `**Product Updated** — ${data.name || data.id}`;
  }

  if (action === "pricing_templates") {
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) return "**Pricing Templates** — none configured";
    return [
      `**Pricing Templates** — ${items.length}`,
      "",
      table(
        ["Name", "Type", "Status"],
        items.map((t: any) => [
          t.name || "—",
          t.type || t.pricing_type || "—",
          badge(t.is_active !== false ? "active" : "inactive"),
        ])
      ),
    ].join("\n");
  }

  return null;
};

// ── CUSTOMERS (lookup — always include UUID) ──

const fmtCustomers: Fmt = (data, input) => {
  const action = input.action as string;

  if (action === "find") {
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) return "**Customers** — none found";

    return [
      `**Customers** — ${items.length} found`,
      "",
      table(
        ["ID", "Name", "Email", "Phone"],
        items.slice(0, 20).map((c: any) => [
          `\`${c.id}\``,
          [c.first_name, c.last_name].filter(Boolean).join(" ") || "—",
          c.email || "—",
          c.phone || "—",
        ])
      ),
    ].join("\n");
  }

  if (action === "create") {
    const name = [data.first_name, data.last_name].filter(Boolean).join(" ");
    return card("Customer Created", [
      ["Name", name || "—"],
      ["Email", data.email || "—"],
      ["ID", `\`${data.id}\``],
    ]);
  }

  if (action === "update") return `**Customer Updated** — ${data.first_name || ""} ${data.last_name || ""}`.trim();
  return null;
};

// ── SUPPLIERS (lookup — always include UUID) ──

const fmtSuppliers: Fmt = (data) => {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) return "**Suppliers** — none found";

  return [
    `**Suppliers** — ${items.length} found`,
    "",
    table(
      ["ID", "Company", "Contact", "Email"],
      items.map((s: any) => [
        `\`${s.id}\``,
        s.external_company || s.external_name || "—",
        s.contact_name || "—",
        s.contact_email || "—",
      ])
    ),
  ].join("\n");
};

// ── TRANSFERS ──

const fmtTransfers: Fmt = (data, input) => {
  const action = input.action as string;

  if (action === "create") {
    // Enriched response from executor with location names and item details
    const from = data.from_location ? loc(data.from_location) : "Source";
    const to = data.to_location ? loc(data.to_location) : "Destination";
    const items = data.items || [];

    const lines = [
      `**Transfer Created** \`${data.transfer_number}\``,
      "",
      `**${from}**  →  **${to}**`,
      "",
    ];

    if (items.length > 0) {
      lines.push(table(
        ["Product", "SKU", "Qty"],
        items.map((i: any) => [
          i.product?.name || "—",
          i.product?.sku ? `\`${i.product.sku}\`` : "—",
          n(i.quantity),
        ])
      ));
      lines.push("");
    }

    lines.push(`${badge(data.status || "in_transit")}  ·  Shipped ${time(data.shipped_at)}`);
    return lines.join("\n");
  }

  if (action === "list") {
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) return "**Transfers** — none found";

    return [
      `**Transfers** — ${items.length} found`,
      "",
      table(
        ["#", "Route", "Status", "Created"],
        items.map((t: any) => {
          const fromName = t.from_location?.name || "—";
          const toName = t.to_location?.name || "—";
          return [
            `\`${t.transfer_number || t.id?.slice(0, 8)}\``,
            `${fromName} → ${toName}`,
            badge(t.status),
            date(t.created_at),
          ];
        })
      ),
    ].join("\n");
  }

  if (action === "get") {
    const from = loc(data.from_location) || data.source_location_id?.slice(0, 8);
    const to = loc(data.to_location) || data.destination_location_id?.slice(0, 8);
    const items = data.items || [];

    const lines = [
      `**Transfer** \`${data.transfer_number || data.id?.slice(0, 8)}\`  —  ${badge(data.status)}`,
      "",
      `**${from}**  →  **${to}**`,
      "",
    ];

    // Dates
    const dates: string[] = [];
    if (data.shipped_at) dates.push(`Shipped ${time(data.shipped_at)}`);
    if (data.received_at) dates.push(`Received ${time(data.received_at)}`);
    if (dates.length > 0) { lines.push(dates.join("  ·  ")); lines.push(""); }

    if (items.length > 0) {
      lines.push(table(
        ["Product", "SKU", "Qty"],
        items.map((i: any) => [
          i.product?.name || "—",
          i.product?.sku ? `\`${i.product.sku}\`` : "—",
          n(i.quantity),
        ])
      ));
    }

    if (data.notes) lines.push("", `> ${data.notes}`);
    return lines.join("\n");
  }

  if (action === "receive") {
    return [
      `**Transfer Received** ${badge("received")}`,
      "",
      `**${n(data.items_received || 0)}** items  ·  **${n(data.total_quantity_received || 0)}** units`,
    ].join("\n");
  }

  if (action === "cancel") return `**Transfer Cancelled** ${badge("cancelled")}`;
  return null;
};

// ── INVENTORY ──

const fmtInventory: Fmt = (data, input) => {
  const action = input.action as string;

  if (action === "adjust" && data.change) {
    const delta = data.change.delta;
    const sign = delta >= 0 ? "+" : "";
    return card(`Inventory Adjusted — ${data.product?.name || "Product"}`, [
      ["Location", data.location?.name || "—"],
      ["Before", n(data.before_state?.quantity)],
      ["After", n(data.after_state?.quantity)],
      ["Change", `**${sign}${delta}**`],
      ["Reason", data.reason || "manual adjustment"],
    ]);
  }

  if (action === "set" && data.change) {
    return card(`Inventory Set — ${data.product?.name || "Product"}`, [
      ["Location", data.location?.name || "—"],
      ["Before", n(data.before_state?.quantity)],
      ["After", n(data.after_state?.quantity)],
      ["Delta", data.change.description || String(data.change.delta)],
    ]);
  }

  if (action === "transfer" && data.before_state) {
    const from = data.from_location?.name || "Source";
    const to = data.to_location?.name || "Destination";
    return [
      `**Stock Transfer** — ${data.product?.name || "Product"}`,
      "",
      `**${from}**  →  **${to}**  ·  ${n(data.quantity_transferred)} units`,
      "",
      table(
        ["Location", "Before", "After", "Change"],
        [
          [from, n(data.before_state.from_quantity), n(data.after_state.from_quantity), `-${n(data.quantity_transferred)}`],
          [to, n(data.before_state.to_quantity), n(data.after_state.to_quantity), `+${n(data.quantity_transferred)}`],
        ]
      ),
    ].join("\n");
  }

  if (action === "bulk_adjust" || action === "bulk_set") {
    return `**Bulk ${action === "bulk_adjust" ? "Adjustment" : "Set"}** — ${data.processed || 0} items processed ${badge("completed")}`;
  }
  if (action === "bulk_clear") {
    return `**Inventory Cleared** — ${data.cleared || 0} items zeroed out ${badge("completed")}`;
  }

  return null;
};

// ── INVENTORY QUERY ──

const fmtInventoryQuery: Fmt = (data, input) => {
  const action = input.action as string;

  if (action === "summary") {
    const lines = [
      "**Inventory Summary**",
      "",
      table(["Metric", "Value"], [
        ["Total SKUs", n(data.totalItems)],
        ["Total Units", n(data.totalQuantity)],
        ["Low Stock", n(data.lowStock)],
        ["Out of Stock", n(data.outOfStock)],
      ]),
    ];

    if (data.items?.length > 0) {
      lines.push("");
      lines.push(table(
        ["Product", "SKU", "Qty"],
        data.items.slice(0, 10).map((i: any) => [
          i.products?.name || i.product_id?.slice(0, 8) || "—",
          i.products?.sku || "—",
          n(i.quantity),
        ])
      ));
    }

    if (data.totalItems > 0) {
      const healthy = data.totalItems - data.lowStock - data.outOfStock;
      lines.push("");
      lines.push(chart("Stock Health", [
        ["Healthy", String(healthy)],
        ["Low Stock", String(data.lowStock)],
        ["Out of Stock", String(data.outOfStock)],
      ]));
    }

    return lines.join("\n");
  }

  if (action === "velocity") {
    const products = data.products || [];
    if (products.length === 0) return "**Product Velocity** — no data for this period";

    const lines = [
      `**Product Velocity** — ${data.days} days`,
      "",
      table(
        ["Product", "Sold", "Revenue", "/Day", "Stock", "Days Left"],
        products.slice(0, 15).map((p: any) => [
          p.name || "—",
          n(p.totalQty),
          $(p.totalRevenue),
          (p.velocityPerDay || 0).toFixed(1),
          n(p.currentStock),
          p.daysOfStock !== null ? n(p.daysOfStock) : "∞",
        ])
      ),
    ];

    if (products.length > 1) {
      lines.push("");
      lines.push(chart("Top Sellers",
        products.slice(0, 6).map((p: any) => [p.name || "?", $(p.totalRevenue)] as [string, string])
      ));
    }

    return lines.join("\n");
  }

  if (action === "by_location") {
    const items = data.items || [];
    const lines = [
      `**Inventory at Location** — ${n(data.item_count)} SKUs · ${n(data.total_quantity)} units`,
    ];
    if (items.length > 0) {
      lines.push("");
      lines.push(table(
        ["Product", "SKU", "Qty"],
        items.slice(0, 20).map((i: any) => [
          i.products?.name || "—",
          i.products?.sku || "—",
          n(i.quantity),
        ])
      ));
    }
    return lines.join("\n");
  }

  return null;
};

// ── PURCHASE ORDERS ──

const fmtPurchaseOrders: Fmt = (data, input) => {
  const action = input.action as string;

  if (action === "create") {
    // Enriched response from executor with location, items, product details
    const items = data.items || [];
    const lines = [
      `**Purchase Order Created** \`${data.po_number}\``,
      "",
    ];

    if (data.location?.name) lines.push(`**Receiving at:** ${loc(data.location)}`);
    if (data.expected_delivery_date) lines.push(`**Expected:** ${date(data.expected_delivery_date)}`);
    if (data.location?.name || data.expected_delivery_date) lines.push("");

    if (items.length > 0) {
      let total = 0;
      lines.push(table(
        ["Product", "SKU", "Qty", "Unit Cost", "Subtotal"],
        items.map((i: any) => {
          const sub = (i.quantity || 0) * (i.unit_price || 0);
          total += sub;
          return [
            i.product?.name || "—",
            i.product?.sku ? `\`${i.product.sku}\`` : "—",
            n(i.quantity),
            $(i.unit_price),
            $(sub),
          ];
        })
      ));
      const grandTotal = data.total_amount || total;
      if (grandTotal > 0) lines.push("", `**Total:** ${$(grandTotal)}`);
      lines.push("");
    }

    lines.push(`${badge(data.status || "draft")}`);
    if (data.notes) lines.push("", `> ${data.notes}`);
    return lines.join("\n");
  }

  if (action === "list") {
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) return "**Purchase Orders** — none found";

    return [
      `**Purchase Orders** — ${items.length} found`,
      "",
      table(
        ["PO #", "Location", "Status", "Total", "Created"],
        items.map((po: any) => [
          `\`${po.po_number || po.id?.slice(0, 8)}\``,
          po.location?.name || "—",
          badge(po.status),
          po.total_amount ? $(po.total_amount) : "—",
          date(po.created_at),
        ])
      ),
    ].join("\n");
  }

  if (action === "get") {
    const items = data.items || [];
    const lines = [
      `**Purchase Order** \`${data.po_number || data.id?.slice(0, 8)}\`  —  ${badge(data.status)}`,
      "",
    ];

    if (data.location?.name) lines.push(`**Receiving at:** ${loc(data.location)}`);
    if (data.expected_delivery_date) lines.push(`**Expected:** ${date(data.expected_delivery_date)}`);
    if (data.location?.name || data.expected_delivery_date) lines.push("");

    if (items.length > 0) {
      let total = 0;
      lines.push(table(
        ["Product", "SKU", "Qty", "Unit Cost", "Subtotal"],
        items.map((i: any) => {
          const sub = (i.quantity || 0) * (i.unit_price || 0);
          total += sub;
          return [
            i.product?.name || "—",
            i.product?.sku ? `\`${i.product.sku}\`` : "—",
            n(i.quantity),
            $(i.unit_price),
            $(sub),
          ];
        })
      ));
      lines.push("", `**Total:** ${$(data.total_amount || total)}`);
    }

    if (data.notes) lines.push("", `> ${data.notes}`);
    return lines.join("\n");
  }

  if (action === "approve") return `**Purchase Order Approved** \`${data.po_number || data.id?.slice(0, 8)}\` ${badge("approved")}`;
  if (action === "receive") {
    return [
      `**PO Received** \`${data.po_number || ""}\`  ${badge("received")}`,
      "",
      `**${data.items_received || 0}** items added to inventory`,
    ].join("\n");
  }
  if (action === "cancel") return `**Purchase Order Cancelled** ${badge("cancelled")}`;
  return null;
};

// ── ORDERS ──

const fmtOrders: Fmt = (data, input) => {
  const action = input.action as string;

  if (action === "find") {
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) return "**Orders** — none found";

    return [
      `**Orders** — ${items.length} found`,
      "",
      table(
        ["Order #", "Status", "Payment", "Total", "Date"],
        items.map((o: any) => [
          `\`${o.order_number || o.id?.slice(0, 8)}\``,
          badge(o.status),
          badge(o.payment_status),
          $(o.total_amount),
          date(o.created_at),
        ])
      ),
    ].join("\n");
  }

  if (action === "get") {
    const items = data.order_items || [];
    const lines = [
      `**Order** \`${data.order_number || data.id?.slice(0, 8)}\`  —  ${badge(data.status)}`,
      "",
    ];

    if (items.length > 0) {
      lines.push(table(
        ["Item", "Qty", "Price", "Subtotal"],
        items.map((i: any) => {
          const price = i.unit_price || i.price || 0;
          return [
            i.product_name || i.name || "—",
            n(i.quantity),
            $(price),
            $((i.quantity || 0) * price),
          ];
        })
      ));
      lines.push("");
    }

    // Totals breakdown as key-value pairs
    lines.push(`**Subtotal**  ${$(data.subtotal)}`);
    lines.push(`**Tax**  ${$(data.tax_amount)}`);
    if (data.discount_amount) lines.push(`**Discount**  -${$(data.discount_amount)}`);
    if (data.shipping_amount) lines.push(`**Shipping**  ${$(data.shipping_amount)}`);
    lines.push(`**Total**  **${$(data.total_amount)}**`);
    lines.push("");
    lines.push(`Payment: ${badge(data.payment_status)}  ·  ${data.payment_method || "—"}`);
    if (data.created_at) lines.push(`Placed: ${time(data.created_at)}`);

    return lines.join("\n");
  }

  return null;
};

// ── ANALYTICS ──

const fmtAnalytics: Fmt = (data, input) => {
  const action = input.action as string;

  if (action === "summary") {
    const s = data.summary || {};
    const dr = data.dateRange || {};
    const period = data.period ? data.period.replace(/_/g, " ") : "custom";

    const lines = [
      `**Sales Summary** — ${period}${dr.from ? ` (${date(dr.from)} – ${date(dr.to)})` : ""}`,
      "",
      table(["Metric", "Value"], [
        ["Revenue", $(s.netSales || s.totalRevenue)],
        ["Cost of Goods", $(s.totalCogs)],
        ["Gross Profit", $(s.totalProfit)],
        ["Profit Margin", pct(s.profitMargin)],
        ["Orders", n(s.totalOrders)],
        ["Avg Order Value", $(s.avgOrderValue)],
        ["Unique Customers", n(s.uniqueCustomers)],
        ["Tax Collected", $(s.taxAmount)],
        ["Discounts", $(s.discountAmount)],
      ]),
    ];

    if (s.netSales || s.totalRevenue) {
      lines.push("");
      lines.push(chart("Revenue Breakdown", [
        ["Net Sales", $(s.netSales || s.totalRevenue)],
        ["Cost of Goods", $(s.totalCogs)],
        ["Gross Profit", $(s.totalProfit)],
        ["Tax", $(s.taxAmount)],
      ]));
    }

    if (s.avgDailyRevenue || s.avgDailyOrders) {
      lines.push("");
      lines.push(`Daily average: ${$(s.avgDailyRevenue)} revenue · ${(s.avgDailyOrders || 0).toFixed(1)} orders`);
    }

    return lines.join("\n");
  }

  if (action === "by_location") {
    const items = Array.isArray(data) ? data : data.daily || [];
    if (items.length === 0) return "**Sales by Location** — no data";

    const byLoc: Record<string, { name: string; revenue: number; orders: number; profit: number }> = {};
    for (const row of items) {
      const name = row.location_name || row.location_id || "Unknown";
      if (!byLoc[name]) byLoc[name] = { name, revenue: 0, orders: 0, profit: 0 };
      byLoc[name].revenue += parseFloat(row.net_sales || row.total_revenue || 0);
      byLoc[name].orders += parseInt(row.order_count || 0);
      byLoc[name].profit += parseFloat(row.total_profit || 0);
    }
    const locs = Object.values(byLoc).sort((a, b) => b.revenue - a.revenue);

    const lines = [
      `**Sales by Location** — ${locs.length} location${locs.length !== 1 ? "s" : ""}`,
      "",
      table(
        ["Location", "Revenue", "Orders", "Profit"],
        locs.map(l => [l.name, $(l.revenue), n(l.orders), $(l.profit)])
      ),
    ];

    if (locs.length > 1) {
      lines.push("");
      lines.push(chart("Revenue by Location",
        locs.slice(0, 6).map(l => [l.name, $(l.revenue)] as [string, string])
      ));
    }

    return lines.join("\n");
  }

  if (action === "discover") {
    if (typeof data === "string") return data;
    return null;
  }

  return null;
};

// ── ALERTS ──

const fmtAlerts: Fmt = (data) => {
  const alerts = data.alerts || [];
  if (alerts.length === 0) return "**System Alerts** — all clear ✓";

  const lines = [`**System Alerts** — ${alerts.length} active`, ""];

  const lowStock = alerts.filter((a: any) => a.type === "low_stock");
  const pendingOrders = alerts.filter((a: any) => a.type === "pending_order");

  if (lowStock.length > 0) {
    lines.push(`**Low Stock** (${lowStock.length})`);
    lines.push("");
    lines.push(table(
      ["Product", "Qty"],
      lowStock.map((a: any) => [a.product || "—", n(a.quantity)])
    ));
    lines.push("");
  }

  if (pendingOrders.length > 0) {
    lines.push(`**Pending Orders** (${pendingOrders.length})`);
    lines.push("");
    lines.push(table(["Order #"], pendingOrders.map((a: any) => [a.order_number || "—"])));
  }

  return lines.join("\n");
};

// ── INVENTORY AUDIT ──

const fmtInventoryAudit: Fmt = (data, input) => {
  const action = input.action as string;

  if (action === "start") {
    return card("Audit Started", [
      ["Audit ID", `\`${data.audit_id || data.id}\``],
      ["Location", data.location_name || data.location_id?.slice(0, 8) || "—"],
      ["Status", badge("pending")],
    ]);
  }

  if (action === "count") {
    return `**Count Recorded** — ${data.product_name || data.product_id?.slice(0, 8)}: **${n(data.counted)}** counted`;
  }

  if (action === "complete") {
    return card("Audit Completed", [
      ["Discrepancies", `${data.discrepancies || 0}`],
      ["Status", badge("completed")],
    ]);
  }

  if (action === "summary") {
    const items = data.items || data.counts || [];
    if (items.length === 0) return "**Audit Summary** — no counts recorded";

    return [
      "**Audit Summary**",
      "",
      table(
        ["Product", "Expected", "Counted", "Variance"],
        items.slice(0, 20).map((i: any) => {
          const variance = (i.counted || 0) - (i.expected || i.system_quantity || 0);
          const sign = variance >= 0 ? "+" : "";
          return [
            i.product_name || i.name || "—",
            n(i.expected || i.system_quantity),
            n(i.counted),
            `**${sign}${variance}**`,
          ];
        })
      ),
    ].join("\n");
  }

  return null;
};

// ── EMAIL ──

const fmtEmail: Fmt = (data, input) => {
  const action = input.action as string;

  if (action === "send" || action === "send_template") {
    return card("Email Sent", [
      ["To", data.to || data.to_email || "—"],
      ["Subject", data.subject || "—"],
      ["Status", badge("success")],
    ]);
  }

  if (action === "list") {
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) return "**Emails** — none found";

    return [
      `**Emails** — ${items.length} found`,
      "",
      table(
        ["To", "Subject", "Status", "Sent"],
        items.slice(0, 15).map((e: any) => [
          e.to_email || "—",
          (e.subject || "—").slice(0, 35),
          badge(e.status),
          date(e.created_at),
        ])
      ),
    ].join("\n");
  }

  if (action === "inbox") {
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) return "**Inbox** — empty";

    return [
      `**Inbox** — ${items.length} thread${items.length !== 1 ? "s" : ""}`,
      "",
      table(
        ["Subject", "From", "Priority", "Status", "Messages", "Last"],
        items.slice(0, 15).map((t: any) => [
          (t.subject || "—").slice(0, 30),
          t.customer ? `${t.customer.first_name || ""} ${t.customer.last_name || ""}`.trim() || t.customer.email : "—",
          t.priority || "—",
          badge(t.status),
          `${t.unread_count || 0}/${t.message_count || 0}`,
          date(t.last_message_at),
        ])
      ),
    ].join("\n");
  }

  if (action === "inbox_stats") {
    if (!data || typeof data !== "object") return null;
    const entries: [string, string][] = [];
    for (const [key, value] of Object.entries(data)) {
      entries.push([key.replace(/_/g, " "), String(value)]);
    }
    return card("Inbox Stats", entries);
  }

  return null;
};

// ── AUDIT TRAIL ──

const fmtAuditTrail: Fmt = (data, input) => {
  const action = input.action as string;

  if (action === "errors") {
    const items = Array.isArray(data) ? data : data.errors || [];
    if (items.length === 0) return "**Audit Trail** — no errors found ✓";

    return [
      `**Recent Errors** — ${items.length}`,
      "",
      table(
        ["Tool", "Error", "Time"],
        items.slice(0, 15).map((e: any) => [
          `\`${e.tool_name || "?"}\``,
          (e.error_message || e.error || "—").slice(0, 50),
          time(e.created_at),
        ])
      ),
    ].join("\n");
  }

  if (action === "tool_stats") {
    const items = Array.isArray(data) ? data : data.stats || [];
    if (items.length === 0) return "**Tool Stats** — no usage data";

    return [
      "**Tool Usage Stats**",
      "",
      table(
        ["Tool", "Calls", "Errors", "Avg Time"],
        items.slice(0, 15).map((s: any) => [
          `\`${s.tool_name || "?"}\``,
          n(s.total_calls || s.count),
          n(s.error_count || s.errors || 0),
          s.avg_duration ? `${Math.round(s.avg_duration)}ms` : "—",
        ])
      ),
    ].join("\n");
  }

  if (action === "cost_summary") {
    if (!data || typeof data !== "object") return null;
    const entries: [string, string][] = [];
    for (const [key, value] of Object.entries(data)) {
      const label = key.replace(/_/g, " ");
      const val = typeof value === "number" && key.includes("cost") ? $(value) : String(value);
      entries.push([label, val]);
    }
    return card("Cost Summary", entries);
  }

  return null;
};

// ============================================================================
// REGISTRY
// ============================================================================

const FORMATTERS: Record<string, Fmt> = {
  inventory: fmtInventory,
  inventory_query: fmtInventoryQuery,
  inventory_audit: fmtInventoryAudit,
  transfers: fmtTransfers,
  purchase_orders: fmtPurchaseOrders,
  orders: fmtOrders,
  analytics: fmtAnalytics,
  alerts: fmtAlerts,
  products: fmtProducts,
  customers: fmtCustomers,
  locations: fmtLocations,
  suppliers: fmtSuppliers,
  email: fmtEmail,
  audit_trail: fmtAuditTrail,
};

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Format a server tool response into clean, professional markdown.
 * Returns null for unknown tool/action combos — caller falls back to JSON.
 */
export function formatServerResponse(
  toolName: string,
  input: Record<string, unknown>,
  data: unknown
): string | null {
  const formatter = FORMATTERS[toolName];
  if (!formatter) return null;

  try {
    return formatter(data, input);
  } catch {
    return null;
  }
}
