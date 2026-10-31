// Which AI account a new thread runs on when the member picks none. Shared accounts (the cloud
// computer's, added by anyone) are in the list too: the member's own come first, as the API's
// usableAccounts orders them, so a shared default never takes over their own plan.
type Pickable = { id: string; mine: boolean; isDefault: boolean }

export function defaultAccount<T extends Pickable>(usable: T[]): T | undefined {
  return (
    usable.find((a) => a.mine && a.isDefault) ??
    usable.find((a) => a.mine) ??
    usable.find((a) => a.isDefault) ??
    usable[0]
  )
}

/** The one picked if it is still usable, else the default. */
export const pickAccount = <T extends Pickable>(usable: T[], pickedId?: string) =>
  usable.find((a) => a.id === pickedId) ?? defaultAccount(usable)
