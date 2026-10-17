import type { ConnectorDefinition } from './types.js'

/**
 * HubSpot's remote MCP server: CRM records, sales, marketing content and inboxes, with
 * the permissions of the HubSpot user who signed in. HubSpot registers no clients, so the
 * sign-in goes through Brigade's MCP connector (HUBSPOT_MCP_CLIENT_ID).
 */
export const hubspot: ConnectorDefinition = {
  kind: 'hubspot',
  label: 'HubSpot',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.hubspot.com',
    whoami: 'get_user_details',
    tools: {
      get_user_details: {
        description: 'The signed-in user, their HubSpot account and what they may read or change.',
        write: false,
      },
      get_organization_details: {
        description: 'The account’s teams, job titles and seats.',
        write: false,
      },
      discover_hubspot_schema: {
        description: 'The object types the account has, and which it may use.',
        write: false,
      },
      search_crm_objects: {
        description: 'Search contacts, companies, deals, tickets and other CRM records.',
        write: false,
      },
      get_crm_objects: { description: 'Fetch CRM records by their IDs.', write: false },
      query_crm_data: { description: 'Query CRM data with SQL.', write: false },
      manage_crm_objects: {
        description: 'Create or update CRM records and log activities.',
        write: true,
      },
      manage_segment: {
        description: 'Create segments, and add or remove their records.',
        write: true,
      },
      search_properties: { description: 'Find an object type’s properties.', write: false },
      get_properties: {
        description: 'Property definitions, with their types and options.',
        write: false,
      },
      manage_custom_properties: { description: 'Create custom properties.', write: true },
      manage_custom_pipelines: { description: 'Create and change pipelines.', write: true },
      search_owners: { description: 'Find record owners by name or email.', write: false },
      get_campaign_attribution_reports: {
        description: 'Revenue and deal attribution of campaigns.',
        write: false,
      },
      read_campaign_data: { description: 'Campaign analytics and asset metrics.', write: false },
      manage_campaign_objects: {
        description: 'Create or update campaigns and their assets.',
        write: true,
      },
      search_conversations: {
        description: 'Search conversations and messages in HubSpot inboxes.',
        write: false,
      },
      get_conversation_channel_metadata: {
        description: 'The inboxes and channels the account has.',
        write: false,
      },
      search_intent_signals: {
        description: 'Buyer intent signals for companies and contacts.',
        write: false,
      },
      get_marketing_email_analytics: { description: 'Marketing email analytics.', write: false },
      manage_marketing_email: {
        description: 'Write and change marketing emails and templates.',
        write: true,
      },
      get_content_analytics_report: {
        description: 'Analytics of landing pages, website pages and blog posts.',
        write: false,
      },
      manage_landing_page: {
        description: 'Create, edit and publish landing pages.',
        write: true,
      },
      manage_website_page: {
        description: 'Create and edit website pages and navigation.',
        write: true,
      },
      manage_blog_post: {
        description: 'Create, edit and publish blog posts.',
        write: true,
      },
      get_aeo_metrics: {
        description: 'How the brand shows in AI search: share of voice and prompts.',
        write: false,
      },
      manage_aeo_prompts: { description: 'Track new AI search prompts.', write: true },
      manage_aeo_recommendations: {
        description: 'Review AI search recommendations and act on them.',
        write: true,
      },
      render_asset: { description: 'A preview card of a content asset.', write: false },
      manage_onboarding: {
        description: 'The account’s onboarding status and next steps.',
        write: false,
      },
      tool_guidance: { description: 'How to use HubSpot’s tools.', write: false },
      submit_feedback: { description: 'Send HubSpot feedback on its MCP server.', write: true },
    },
  },
}
