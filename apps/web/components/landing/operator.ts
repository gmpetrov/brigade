// Who runs the hosted service at www.brigade.lol: the legal pages name it (French law asks
// the legal notice for it, and the terms and the DPA are contracts with it). Until the
// company exists, `company` is null: the pages say "Brigade", and /legal is not published.
type Company = {
  /** The legal name and form, e.g. "Brigade SAS". */
  name: string
  /** Share capital, as French law asks a company to show it. */
  capital: string
  address: string
  /** RCS city and SIREN number, e.g. "RCS Paris 123 456 789". */
  registration: string
  vat: string
  /** The publication director (directeur de la publication). */
  director: string
}

const company = null as Company | null

export const OPERATOR = {
  company,
  /** How the legal pages name the party to their contracts. */
  name: company?.name ?? 'Brigade',
  email: 'support@brigade.lol',
}
