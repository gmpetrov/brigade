# Abuse

What keeps Brigade from being used to send spam, attack other sites or mine on its machines.

## Sign-up

- **Rate limits**: sign-in requests are counted per visitor (`cf-connecting-ip`) in the
  `RateLimit` table (`apps/api/src/auth.ts`).
- **Cloudflare Turnstile**: with `TURNSTILE_SECRET_KEY` (a secret of `brigade-api`) and
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (a build variable of `brigade-web`, inlined by Next), a
  sign-in code is mailed, and a password account made, only after Turnstile's check. The
  widget is `brigade` in Cloudflare's Turnstile settings, for `brigade.lol` and its
  subdomains. Set the site key first and let the dashboard deploy: an API with the secret
  refuses a dashboard without the widget.

## Cloud computers

Teammates run as Linux users of their own (`bt-…`, in `brigade-teammates`), never root, so
rules root sets hold for everything they start: their commands, previews, terminals,
browsers and rootless Docker.

### What is stopped

`/usr/local/sbin/brigade-egress` (`EGRESS_SCRIPT` in `apps/api/src/cloud-bootstrap.ts`), set
by the setup and at each boot (`brigade-egress.service`), in iptables' mangle table, for
teammates' processes on the host and their threads' namespaces (traffic in from `btn+`):

| Rule       | Stops                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `smtp`     | New connections to port 25: mail straight to mail servers. 465 and 587 (a mail service's own, with a login) stay open.                                       |
| `metadata` | 169.254.0.0/16: the cloud's metadata address.                                                                                                                |
| `scan`     | New connections past a burst of 1,000, then past 100 a second, per source (each thread's namespace; teammates' processes on the host together).              |
| `mining`   | A connection whose first 4 KB hold a mining pool's protocol in the clear (stratum's `mining.subscribe`, `mining.authorize`, `mining.submit`; XMRig's login). |

The runner (`apps/runner/src/abuse.ts`), every 2 minutes:

- reads what each rule stopped (`brigade-teammate egress-counts`);
- kills miners among teammates' processes found by their program's name (`xmrig`, `cpuminer`,
  `lolminer`…), their rootless containers' processes included (`brigade-teammate stop-process`);
  one that only passes a pool's address (`stratum+tcp://…`) or `--donate-level` as an argument
  of its own is told and left running, since another program may (a search for that text is
  neither);
- notes a teammate whose processes keep 80% of all cores for 30 minutes: only told, since a
  long build does too.

It reports what it found (`abuse`); while the runner is not connected, the report waits, added
to the next, and goes once it is. The API raises `abuse:<computerId>`
(`apps/api/src/computer-abuse.ts`): critical for anything stopped or killed, a warning for
CPU alone or a pool only in arguments, over an hour after the last report.

### When the alert comes

Members are told nothing. An operator looks:

1. Which workspace (the alert says) and which teammate (`bt-…` for miners and CPU; for
   packets, the computer's threads running then).
2. A mistake (a tool that mails through port 25, an app that opens thousands of
   connections) or abuse? A legitimate case may warrant a limit that changes in
   `EGRESS_SCRIPT`.
3. Abuse: cancel the workspace's plan in Stripe, which stops the computer
   (docs/billing.md), and refund or not; ban its members' addresses.

### Not covered

- Mining over TLS by a renamed program: only the CPU warning sees it.
- Thread preview machines (`run_on_machine`, previews on machines of their own): teammates have
  root there, so rules on the machine would not hold. They are short-lived and billed by the
  second; limits there need the provider's own network rules.
