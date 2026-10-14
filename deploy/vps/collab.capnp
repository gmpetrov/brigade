# Collab (apps/collab) in workerd on the VPS: the same Worker as on Cloudflare, with
# its DocRoom Durable Objects stored in SQLite under /data (a volume).
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "collab", worker = .collab),
    (name = "rooms", disk = (path = "/data", writable = true)),
    # API_URL is the API inside the Compose network, a private address.
    (name = "internet", network = (allow = ["public", "private"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [(name = "http", address = "*:8787", http = (), service = "collab")],
);

const collab :Workerd.Worker = (
  modules = [(name = "index.js", esModule = embed "index.js")],
  compatibilityDate = "2026-09-01",
  bindings = [
    (name = "API_URL", fromEnvironment = "API_URL"),
    (name = "COLLAB_SECRET", fromEnvironment = "COLLAB_SECRET"),
    (name = "DocRoom", durableObjectNamespace = "DocRoom"),
  ],
  durableObjectNamespaces = [
    (className = "DocRoom", uniqueKey = "brigade-collab-DocRoom", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "rooms"),
);
