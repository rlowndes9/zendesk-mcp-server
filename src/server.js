import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gateToolByScope } from './lib/foundations.js';

// Meta, triggers, analyzers and routing.
import { metaTools } from './tools-v1/meta.js';
import { triggersTools as triggersToolsV1 } from './tools-v1/triggers.js';
import { triggerAnalysisTools } from './tools-v1/trigger-analysis.js';
import { routingTools as routingToolsV1 } from './tools-v1/routing.js';

// Core resources.
import { ticketsTools } from './tools-v1/tickets.js';
import { usersTools } from './tools-v1/users.js';
import { organizationsTools } from './tools-v1/organizations.js';
import { groupsTools } from './tools-v1/groups.js';
import { macrosTools } from './tools-v1/macros.js';
import { viewsTools } from './tools-v1/views.js';
import { automationsTools } from './tools-v1/automations.js';
import { searchTools } from './tools-v1/search.js';
import { talkTools } from './tools-v1/talk.js';
import { chatTools } from './tools-v1/chat.js';

// Schema primitives.
import { ticketFieldsToolsV1 } from './tools-v1/ticket-fields.js';
import { ticketFormsToolsV1 } from './tools-v1/ticket-forms.js';
import { customStatusesToolsV1 } from './tools-v1/custom-statuses.js';
import { triggerCategoriesToolsV1 } from './tools-v1/trigger-categories.js';
import { organizationFieldsToolsV1 } from './tools-v1/organization-fields.js';
import { userFieldsToolsV1 } from './tools-v1/user-fields.js';

// Structure primitives.
import { brandsTools } from './tools-v1/brands.js';
import { localesTools } from './tools-v1/locales.js';
import { customRolesTools } from './tools-v1/custom-roles.js';
import { schedulesTools } from './tools-v1/schedules.js';
import { slaPoliciesTools } from './tools-v1/sla-policies.js';

// Channel primitives.
import { webhooksTools } from './tools-v1/webhooks.js';
import { targetsTools } from './tools-v1/targets.js';
import { dynamicContentTools } from './tools-v1/dynamic-content.js';
import { auditLogsTools } from './tools-v1/audit-logs.js';

// Analyzers.
import { usageAnalysisTools } from './tools-v1/usage-analysis.js';
import { tagAnalysisTools } from './tools-v1/tag-analysis.js';
import { unusedTools } from './tools-v1/unused.js';

// Audit composites.
import { summarizeTools } from './tools-v1/summarize.js';
import { auditFieldHealthTools } from './tools-v1/audit-field-health.js';
import { auditTriggerHealthTools } from './tools-v1/audit-trigger-health.js';
import { auditTagSprawlTools } from './tools-v1/audit-tag-sprawl.js';

const server = new McpServer({
  name: 'zendesk-mcp-server',
  version: '0.1.0',
  description: 'MCP Server for read-only Zendesk admin/audit introspection',
});

const allTools = [
  ...metaTools,
  ...triggersToolsV1,
  ...triggerAnalysisTools,
  ...ticketFieldsToolsV1,
  ...ticketFormsToolsV1,
  ...customStatusesToolsV1,
  ...triggerCategoriesToolsV1,
  ...organizationFieldsToolsV1,
  ...userFieldsToolsV1,
  ...brandsTools,
  ...localesTools,
  ...customRolesTools,
  ...schedulesTools,
  ...slaPoliciesTools,
  ...webhooksTools,
  ...targetsTools,
  ...dynamicContentTools,
  ...auditLogsTools,
  ...routingToolsV1,
  ...ticketsTools,
  ...usersTools,
  ...organizationsTools,
  ...groupsTools,
  ...macrosTools,
  ...viewsTools,
  ...automationsTools,
  ...searchTools,
  ...talkTools,
  ...chatTools,
  ...usageAnalysisTools,
  ...tagAnalysisTools,
  ...unusedTools,
  ...summarizeTools,
  ...auditFieldHealthTools,
  ...auditTriggerHealthTools,
  ...auditTagSprawlTools,
];

// Behaviour hints for clients (e.g. auto-approval of safe reads). Every tool
// in v1 is read-only against Zendesk; the two meta tools that mutate
// server-local session/cache state are the only ones without readOnlyHint.
const LOCAL_READERS = new Set(['list_instances', 'current_instance']);
const LOCAL_MUTATORS = new Set(['set_instance', 'refresh_instance']);

function annotationsFor(name) {
  if (LOCAL_MUTATORS.has(name)) {
    // Change the sticky instance / drop the cache, server-local, never
    // touches Zendesk, and re-running with the same args is a no-op.
    return {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  }
  if (LOCAL_READERS.has(name)) {
    // Read local config/session only; no external call.
    return { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
  }
  // Everything else is a GET against the Zendesk API.
  return { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
}

// Wrap each tool with a scope gate before registration. Tools that only
// require "config" (the default) are returned unchanged; tools that touch
// ticket / user / organization data are gated by the resolved instance's
// scope. See src/lib/scope.js for the policy.
allTools.map(gateToolByScope).forEach((tool) => {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.schema,
      annotations: { title: tool.name, ...annotationsFor(tool.name) },
    },
    tool.handler,
  );
});

server.resource(
  'documentation',
  new ResourceTemplate('zendesk://docs/{section}', { list: undefined }),
  async (uri, { section }) => {
    const docs = {
      tickets: 'Tickets API.',
      users: 'Users API.',
      organizations: 'Organizations API.',
      groups: 'Groups API.',
      macros: 'Macros API.',
      views: 'Views API.',
      triggers: 'Triggers API.',
      automations: 'Automations API.',
      search: 'Search API.',
      overview:
        'The Zendesk API is a RESTful API. v1 of this MCP exposes read-only admin/audit primitives.',
    };

    if (!section || section === 'all') {
      return {
        contents: [
          {
            uri: uri.href,
            text: `Zendesk API Documentation Overview\n\n${Object.keys(docs)
              .map((key) => `- ${key}: ${docs[key].split('\n')[0]}`)
              .join('\n')}`,
          },
        ],
      };
    }
    if (docs[section]) {
      return {
        contents: [
          { uri: uri.href, text: `Zendesk API Documentation: ${section}\n\n${docs[section]}` },
        ],
      };
    }
    return {
      contents: [
        {
          uri: uri.href,
          text: `Documentation section '${section}' not found. Available: ${Object.keys(docs).join(', ')}`,
        },
      ],
    };
  },
);

export { server };
