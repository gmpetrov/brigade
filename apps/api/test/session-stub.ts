/**
 * A stand-in for auth.api.getSession that answers with session(headers), read on each call, in
 * the shape each caller asks for: requireUser (src/scope.ts) reads it with returnHeaders, to pass
 * on the renewed cookie; the socket reads take the session alone.
 */
export const sessionStub =
  <S>(session: (headers: Headers) => S) =>
  async ({ headers, returnHeaders }: { headers: Headers; returnHeaders?: boolean }) => {
    const value = session(headers)
    return returnHeaders ? { headers: new Headers(), response: value } : value
  }
