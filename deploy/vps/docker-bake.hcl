# The VPS images, built together so they share one install (deploy/vps/Dockerfile):
#   TAG=<commit> docker buildx bake -f deploy/vps/docker-bake.hcl [--push]
variable "TAG" {
  default = "local"
}

variable "REGISTRY" {
  default = "ghcr.io/gmpetrov"
}

group "default" {
  targets = ["api", "web", "collab"]
}

target "_common" {
  context    = "."
  dockerfile = "deploy/vps/Dockerfile"
  # The server is ARM (Hetzner CAX).
  platforms = ["linux/arm64"]
  labels = {
    "org.opencontainers.image.source" = "https://github.com/gmpetrov/brigade"
  }
}

target "api" {
  inherits = ["_common"]
  target   = "api"
  tags     = ["${REGISTRY}/brigade-api:${TAG}"]
}

target "web" {
  inherits = ["_common"]
  target   = "web"
  tags     = ["${REGISTRY}/brigade-web:${TAG}"]
  args = {
    NEXT_PUBLIC_API_URL = "https://api.vps.brigade.lol"
  }
}

target "collab" {
  inherits = ["_common"]
  target   = "collab"
  tags     = ["${REGISTRY}/brigade-collab:${TAG}"]
}
