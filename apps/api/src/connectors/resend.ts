import type { ConnectorDefinition } from './types.js'

const read = (description: string) => ({ description, write: false })
const write = (description: string) => ({ description, write: true })

/**
 * Resend's own MCP server: emails sent and received, templates, broadcasts, contacts,
 * segments, topics, automations, domains, webhooks, API keys and request logs, for the team
 * the person picks on Resend's consent page. Resend registers Brigade as a client itself
 * (dynamic client registration). The server marks none of its tools read-only: Brigade's
 * list says which ones only read, so a read-only grant still gets them.
 */
export const resend: ConnectorDefinition = {
  kind: 'resend',
  label: 'Resend',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.resend.com/mcp',
    // Resend offers full_access and emails:send, and its resource lists neither.
    scopes: ['full_access'],
    // No tool names the team: an account shows as its sending domains.
    account: { tool: 'list-domains', name: resendAccountName },
    tools: {
      'send-email': write('Send an email now, or schedule it.'),
      'send-batch-emails': write('Send up to 100 emails at once.'),
      'list-emails': read('List the emails sent, with their status.'),
      'get-email': read('Read a sent email, its HTML and text.'),
      'update-email': write('Reschedule a scheduled email.'),
      'cancel-email': write('Cancel a scheduled email.'),
      'list-sent-email-attachments': read('List a sent email’s attachments.'),
      'get-sent-email-attachment': read('A sent email’s attachment, with a download link.'),
      'list-received-emails': read('List the emails received.'),
      'get-received-email': read('Read a received email, its content and headers.'),
      'list-received-email-attachments': read('List a received email’s attachments.'),
      'get-received-email-attachment': read('A received email’s attachment, with a download link.'),
      'list-templates': read('List the email templates.'),
      'get-template': read('Read a template.'),
      'create-template': write('Create a draft template.'),
      'update-template': write('Change a template.'),
      'compose-template': write('Set a template’s content in Resend’s editor.'),
      'duplicate-template': write('Copy a template.'),
      'publish-template': write('Publish a template, to send with it.'),
      'remove-template': write('Delete a template.'),
      'list-broadcasts': read('List the broadcasts.'),
      'get-broadcast': read('Read a broadcast.'),
      'create-broadcast': write('Create a broadcast to a segment, without sending it.'),
      'update-broadcast': write('Change a broadcast.'),
      'compose-broadcast': write('Set a broadcast’s content in Resend’s editor.'),
      'send-broadcast': write('Send a broadcast to its segment, now or later.'),
      'remove-broadcast': write('Delete a broadcast.'),
      'get-tiptap-json-content': read('A template’s or broadcast’s editor content.'),
      'connect-to-editor': write('Show the teammate in Resend’s editor.'),
      'disconnect-from-editor': write('Leave Resend’s editor.'),
      'list-contacts': read('List the contacts, by segment.'),
      'get-contact': read('Read a contact.'),
      'create-contact': write('Create a contact.'),
      'update-contact': write('Change a contact.'),
      'remove-contact': write('Delete a contact.'),
      'list-contact-segments': read('The segments a contact belongs to.'),
      'add-contact-to-segment': write('Add a contact to a segment.'),
      'remove-contact-from-segment': write('Take a contact out of a segment.'),
      'list-contact-topics': read('A contact’s topic subscriptions.'),
      'update-contact-topics': write('Change a contact’s topic subscriptions.'),
      'list-contact-properties': read('List the contacts’ custom properties.'),
      'get-contact-property': read('Read a contact property.'),
      'create-contact-property': write('Create a contact property.'),
      'update-contact-property': write('Change a contact property’s fallback value.'),
      'remove-contact-property': write('Delete a contact property.'),
      'list-segments': read('List the segments.'),
      'get-segment': read('Read a segment.'),
      'create-segment': write('Create a segment.'),
      'remove-segment': write('Delete a segment.'),
      'list-topics': read('List the topics contacts subscribe to.'),
      'get-topic': read('Read a topic.'),
      'create-topic': write('Create a topic.'),
      'update-topic': write('Change a topic.'),
      'remove-topic': write('Delete a topic.'),
      'get-automation': read('Read an automation, or list them.'),
      'get-automation-runs': read('An automation’s runs.'),
      'create-automation': write('Create an automation.'),
      'update-automation': write('Change, turn on or turn off an automation.'),
      'remove-automation': write('Delete an automation.'),
      'send-event': write('Send an event for a contact, to start automations.'),
      'manage-events': write('Create, list, change or delete event definitions.'),
      'list-domains': read('List the sending domains and their status.'),
      'get-domain': read('Read a domain and its DNS records.'),
      'create-domain': write('Add a domain.'),
      'update-domain': write('Change a domain’s tracking, TLS or capabilities.'),
      'verify-domain': write('Start a domain’s DNS verification.'),
      'remove-domain': write('Delete a domain.'),
      'list-webhooks': read('List the webhooks.'),
      'get-webhook': read('Read a webhook.'),
      'create-webhook': write('Create a webhook.'),
      'update-webhook': write('Change a webhook.'),
      'remove-webhook': write('Delete a webhook.'),
      'list-api-keys': read('List the API keys, by name.'),
      'create-api-key': write('Create an API key.'),
      'remove-api-key': write('Delete an API key.'),
      'list-logs': read('List the API requests made.'),
      'get-log': read('Read an API request, with its request and response.'),
    },
  },
}

/**
 * The Resend account as a row shows it: its domains' names. list-domains answers in text, a
 * block per domain ("Name: example.com\nID: …\nStatus: verified…") after a "Found 2 domains:"
 * line, else "No domains found.".
 */
export function resendAccountName(output: unknown): string | null {
  if (typeof output !== 'string') return null
  const names = [...output.matchAll(/^Name: (.+)$/gm)].map((m) => m[1]!.trim()).filter(Boolean)
  if (!names.length) return null
  return names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`
}
