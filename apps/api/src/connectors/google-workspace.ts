import type { ConnectorDefinition } from './types.js'

/**
 * Google Drive, Docs and Sheets through Google's own MCP servers, one App each. Google
 * registers no clients, so the sign-in goes through Brigade's own (GOOGLE_MCP_CLIENT_ID),
 * whose project needs each server's API enabled (drivemcp, docsmcp, sheetsmcp.googleapis.com)
 * beside the product's own. The scopes come from each server's resource metadata.
 */
export const googleDrive: ConnectorDefinition = {
  kind: 'google_drive',
  label: 'Google Drive',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    tools: {
      search_files: { description: 'Search Drive files with a structured query.', write: false },
      list_recent_files: { description: 'List recent files, most recent first.', write: false },
      get_file_metadata: { description: "A file's details and a snippet of it.", write: false },
      get_file_permissions: { description: 'Who a file is shared with.', write: false },
      read_file_content: {
        description: "A file's content as text, with its comments if asked.",
        write: false,
      },
      download_file_content: {
        description: "A file's content, exported to a format for Google files.",
        write: false,
      },
      create_file: {
        description: 'Create or upload a file, a Google Doc, Sheet or Slides included.',
        write: true,
      },
      copy_file: { description: 'Copy a file, with a new title or folder.', write: true },
    },
  },
}

export const googleDocs: ConnectorDefinition = {
  kind: 'google_docs',
  label: 'Google Docs',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://docsmcp.googleapis.com/mcp/v1',
    tools: {
      read_doc: { description: "A document's text and structure.", write: false },
      update_doc: {
        description: 'Change a document: text, styles, tables and more, as batch updates.',
        write: true,
      },
    },
  },
}

export const googleSheets: ConnectorDefinition = {
  kind: 'google_sheets',
  label: 'Google Sheets',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://sheetsmcp.googleapis.com/mcp/v1',
    tools: {
      get_spreadsheet: {
        description: "A spreadsheet's sheets and their sizes, and its cells if asked.",
        write: false,
      },
      get_values: { description: 'Read the values of a range.', write: false },
      update_values: { description: 'Write values into a range.', write: true },
      update_formulas: { description: 'Set formulas in a range.', write: true },
      insert_dimension: { description: 'Insert rows or columns.', write: true },
      update_spreadsheet: {
        description:
          'Change a spreadsheet: sheets, formatting, sorting and more, as batch updates.',
        write: true,
      },
    },
  },
}
