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
  library-view) # <user>: the teammate's own library mirror, which only it (and the runner) reads
    user_ok "$2"
    id "$2" >/dev/null 2>&1 || fail "no such user"
    install -d -o brigade -g "$2" -m 2750 "/var/lib/brigade/library/$2"
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
    # A resumed computer has a new hostname, and Chrome refuses a profile still locked by
    # its last run "on another computer". With none of the teammate's Chromes running,
    # that lock is stale: remove it, as the teammate.
    if ! pgrep -u "$2" -f "user-data-dir=/home/$2/.browser" >/dev/null; then
      runuser -u "$2" -- rm -f "/home/$2/.browser/SingletonLock" "/home/$2/.browser/SingletonCookie" \\
        "/home/$2/.browser/SingletonSocket"
    fi
    cd /
    # Chrome's output goes to ~/.browser.log, written as the teammate, so the runner can
    # say why it did not start.
    setsid -f runuser -u "$2" -- env -i HOME="/home/$2" USER="$2" LOGNAME="$2" DISPLAY=:0 \\
      PATH=/usr/bin:/bin LANG=C.UTF-8 sh -c 'exec "$@" >"$HOME/.browser.log" 2>&1' sh \\
      google-chrome --user-data-dir="/home/$2/.browser" \\
      --remote-debugging-port="$3" --no-first-run --no-default-browser-check \\
      --password-store=basic --class="brigade-$2" --window-name="$4" \${URL:+"$URL"} \\
      >/dev/null 2>&1 </dev/null
    ;;
  containers) # <user>: the teammate's own rootless Docker, under its user session; prints its uid
    user_ok "$2"
    U=$(id -u "$2") || fail "no such user"
    # No rootless Docker on this computer: nothing to start, and no uid printed.
    command -v dockerd-rootless-setuptool.sh >/dev/null && command -v newuidmap >/dev/null || exit 0
    grep -q "^$2:" /etc/subuid || fail "no subordinate ids for $2"
    # A user manager that outlives any login: it runs the daemon.
    loginctl enable-linger "$2"
    I=0
    while [ ! -S "/run/user/$U/bus" ] && [ $I -lt 60 ]; do sleep 0.25; I=$((I + 1)); done
    [ -S "/run/user/$U/bus" ] || fail "no user session for $2"
    cd /
    runuser -u "$2" -- env -i HOME="/home/$2" USER="$2" LOGNAME="$2" PATH=/usr/bin:/bin:/usr/sbin:/sbin \\
      XDG_RUNTIME_DIR="/run/user/$U" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$U/bus" \\
      sh -c 'systemctl --user is-active --quiet docker.service ||
        dockerd-rootless-setuptool.sh install --force >"$HOME/.docker-setup.log" 2>&1' ||
      fail "rootless Docker did not start for $2 (see its ~/.docker-setup.log)"
    I=0
    while [ ! -S "/run/user/$U/docker.sock" ] && [ $I -lt 120 ]; do sleep 0.25; I=$((I + 1)); done
    [ -S "/run/user/$U/docker.sock" ] || fail "no Docker socket for $2"
    echo "$U"
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
# Containers for teammates: each runs its own rootless Docker (the helper's \`containers\`),
# never the root daemon, whose socket would make it root. Where Docker is installed.
if command -v dockerd-rootless-setuptool.sh >/dev/null; then
  NEED=""
  for P in uidmap slirp4netns dbus-user-session; do dpkg -s "$P" >/dev/null 2>&1 || NEED="$NEED $P"; done
  if [ -n "$NEED" ]; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $NEED >/dev/null
  fi
  # Ubuntu 24.04 may restrict user namespaces to profiled programs: allow rootlesskit's.
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] &&
    [ ! -f /etc/apparmor.d/brigade-rootlesskit ]; then
    sudo tee /etc/apparmor.d/brigade-rootlesskit >/dev/null <<'APPARMOR'
abi <abi/4.0>,
include <tunables/global>

/usr/bin/rootlesskit flags=(unconfined) {
  userns,
  include if exists <local/brigade-rootlesskit>
}
APPARMOR
    sudo apparmor_parser -r /etc/apparmor.d/brigade-rootlesskit
  fi
fi
# The workspace library, mirrored by the runner: one folder per teammate user, made by the
# helper, holding only what that teammate may read. Teammates pass through, never list it.
sudo install -d -o brigade -g brigade-teammates -m 2710 /var/lib/brigade/library
sudo chmod 2710 /var/lib/brigade/library
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
