// What the API runs on a new workspace computer, through the provider. Generic
// Ubuntu with sudo: no provider names here.
import { createHash } from 'node:crypto'

/**
 * Root helper the runner may call through sudo, and nothing else as root. It
 * manages teammate Linux users and shares account logins with them without
 * ever reading a login file.
 */
export const TEAMMATE_HELPER = `#!/bin/sh
# Brigade teammate helper. Called by the brigade runner through sudo.
set -eu
GROUP=brigade-teammates
ACCOUNTS=/var/lib/brigade/accounts
fail() { echo "brigade-teammate: $1" >&2; exit 2; }
user_ok() { echo "$1" | grep -Eq '^bt-[a-z0-9]{1,28}$' || fail "bad user"; }
id_ok() { echo "$1" | grep -Eq '^[A-Za-z0-9_-]{1,64}$' || fail "bad id"; }
cred() { case "$1" in claude_code) echo .credentials.json ;; codex) echo auth.json ;; *) fail "bad provider" ;; esac; }

case "\${1:-}" in
  ensure-user) # <user>: a Linux user with a private home
    user_ok "$2"
    id "$2" >/dev/null 2>&1 || useradd -m -s /bin/bash -U -G "$GROUP" "$2"
    chmod 700 "/home/$2"
    ;;
  share-account) # <accountId>: after a sign-in, let teammate users use the login
    id_ok "$2"
    D="$ACCOUNTS/$2"
    [ -d "$D" ] || exit 0
    chown -R brigade:"$GROUP" "$D"
    chmod -R g+rwX,o-rwx "$D"
    find "$D" -type d -exec chmod g+s {} +
    ;;
  link-account) # <user> <accountId> <provider>: a private config dir sharing only the login file
    user_ok "$2"; id_ok "$3"; F=$(cred "$4")
    D="/home/$2/.accounts/$3"
    install -d -o "$2" -g "$2" -m 700 "/home/$2/.accounts" "$D"
    if [ ! -L "$D/$F" ]; then
      [ -f "$D/$F" ] && mv -f "$D/$F" "$ACCOUNTS/$3/$F" && chown brigade:"$GROUP" "$ACCOUNTS/$3/$F" && chmod 660 "$ACCOUNTS/$3/$F"
      ln -sfn "$ACCOUNTS/$3/$F" "$D/$F"
      chown -h "$2:$2" "$D/$F"
    fi
    ;;
  browser) # <user> <port> <title> [url]: the teammate's Chrome on the desktop, its own profile
    user_ok "$2"
    echo "$3" | grep -Eq '^[0-9]{4,5}$' || fail "bad port"
    echo "$4" | grep -Eq '^[A-Za-z0-9 ._-]{1,60}$' || fail "bad title"
    URL="\${5:-}"
    if [ -n "$URL" ]; then echo "$URL" | grep -Eq '^https?://[^[:space:]]+$' || fail "bad url"; fi
    U=$(id -u "$2")
    # Only the teammate's own user may reach its browser's debugging port.
    for T in iptables ip6tables; do
      command -v "$T" >/dev/null || continue
      "$T" -C OUTPUT -o lo -p tcp --dport "$3" -m owner ! --uid-owner "$U" -j REJECT 2>/dev/null ||
        "$T" -I OUTPUT -o lo -p tcp --dport "$3" -m owner ! --uid-owner "$U" -j REJECT
    done
    # Its windows show on the computer's desktop, where a person can take over.
    AUTH=$(ps -o args= -C Xorg | sed -n 's/.* -auth \\([^ ]*\\).*/\\1/p' | head -1)
    DISPLAY=:0 XAUTHORITY="$AUTH" xhost "+SI:localuser:$2" >/dev/null || fail "no desktop"
    install -d -o "$2" -g "$2" -m 700 "/home/$2/.browser"
    cd /
    setsid -f runuser -u "$2" -- env -i HOME="/home/$2" USER="$2" LOGNAME="$2" DISPLAY=:0 \\
      PATH=/usr/bin:/bin LANG=C.UTF-8 google-chrome --user-data-dir="/home/$2/.browser" \\
      --remote-debugging-port="$3" --no-first-run --no-default-browser-check \\
      --password-store=basic --class="brigade-$2" --window-name="$4" \${URL:+"$URL"} \\
      >/dev/null 2>&1 </dev/null
    ;;
  clipboard) # get|set: the desktop's clipboard as UTF-8, on stdout or from stdin
    AUTH=$(ps -o args= -C Xorg | sed -n 's/.* -auth \\([^ ]*\\).*/\\1/p' | head -1)
    [ -n "$AUTH" ] || fail "no desktop"
    export DISPLAY=:0 XAUTHORITY="$AUTH"
    case "\${2:-}" in
      get) timeout 3 xclip -o -selection clipboard 2>/dev/null || true ;;
      set) # both selections: Shift+Insert pastes PRIMARY in terminals, CLIPBOARD in browsers
        T=$(mktemp)
        trap 'rm -f "$T"' EXIT
        head -c 1000000 >"$T"
        for S in clipboard primary; do
          xclip -i -selection "$S" "$T" >/dev/null 2>&1 </dev/null
        done
        ;;
      *) fail "bad clipboard command" ;;
    esac
    ;;
  *) fail "unknown command" ;;
esac
`

/**
 * The root-owned parts of a workspace computer that change with Brigade: the
 * teammate helper and the library folder. Run by the bootstrap, and again on
 * any computer whose runner reports another stamp (a runner update cannot
 * change root-owned files).
 */
const SETUP = `set -eu
getent group brigade-teammates >/dev/null || sudo groupadd brigade-teammates
sudo tee /usr/local/sbin/brigade-teammate >/dev/null <<'HELPER'
${TEAMMATE_HELPER}HELPER
sudo chmod 755 /usr/local/sbin/brigade-teammate
# The workspace library, mirrored by the runner and read by teammate users.
sudo install -d -o brigade -g brigade-teammates -m 2750 /var/lib/brigade/library
`

/** Identifies the current setup; the runner reports the one last applied. */
export const SETUP_SHA = createHash('sha256').update(SETUP).digest('hex')

export const setupScript = () =>
  `${SETUP}echo ${SETUP_SHA} | sudo tee /var/lib/brigade/setup >/dev/null
`

const install = '/opt/brigade'
const runner = `${install}/bin/brigade-runner`

/**
 * Reinstall the runner from the API's bundle and restart it. For runners too
 * old to update themselves; newer ones run the installer on their own.
 */
export const reinstallScript = (apiUrl: string) => `set -eu
sudo -u brigade -H env BRIGADE_INSTALL_DIR=${install} sh -c 'curl -fsSL ${apiUrl}/runner/install.sh | sh'
sudo systemctl restart brigade-runner
`

/** Install the runner under its own Linux user, as a service that survives stop and resume. */
export function bootstrapScript(input: { apiUrl: string; code: string }) {
  return `set -eu
id brigade >/dev/null 2>&1 || sudo useradd -m -s /bin/bash brigade
getent group brigade-teammates >/dev/null || sudo groupadd brigade-teammates

# Runner and Node.js in /opt (readable by teammate users); its own data stays private.
sudo install -d -o brigade -g brigade -m 755 ${install}
sudo -u brigade -H env BRIGADE_INSTALL_DIR=${install} sh -c 'curl -fsSL ${input.apiUrl}/runner/install.sh | sh'
sudo install -d -o brigade -g brigade-teammates -m 2770 /var/lib/brigade/accounts
sudo chmod 755 /var/lib/brigade

${setupScript()}
# Teammate users: the runner may create them, run as them, and share logins with them. Nothing else as root.
sudo tee /etc/sudoers.d/brigade-runner >/dev/null <<'SUDOERS'
Defaults:brigade !requiretty
brigade ALL=(root) NOPASSWD: /usr/local/sbin/brigade-teammate
brigade ALL=(%brigade-teammates) NOPASSWD:SETENV: ALL
SUDOERS
sudo chmod 440 /etc/sudoers.d/brigade-runner
sudo visudo -cq

sudo -u brigade -H ${runner} link ${input.code} --api ${input.apiUrl} --name 'Workspace computer'
sudo tee /etc/systemd/system/brigade-runner.service >/dev/null <<'UNIT'
[Unit]
Description=Brigade runner
After=network-online.target
Wants=network-online.target

[Service]
User=brigade
WorkingDirectory=/home/brigade
Environment=HOME=/home/brigade
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=BRIGADE_CLOUD=1
Environment=BRIGADE_ACCOUNTS_DIR=/var/lib/brigade/accounts
Environment=BRIGADE_SHIM_DIR=${install}/bin/shims
ExecStart=${runner} start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable brigade-runner
sudo systemctl restart brigade-runner
`
}
