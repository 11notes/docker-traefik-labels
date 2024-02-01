![Banner](https://github.com/11notes/defaults/blob/main/static/img/banner.png?raw=true)

# 🏔️ Alpine - Traefik Labels
![size](https://img.shields.io/docker/image-size/11notes/traefik-labels/0.2.1?color=0eb305) ![version](https://img.shields.io/docker/v/11notes/traefik-labels/0.2.1?color=eb7a09) ![pulls](https://img.shields.io/docker/pulls/11notes/traefik-labels?color=2b75d6) ![activity](https://img.shields.io/github/commit-activity/m/11notes/docker-traefik-labels?color=c91cb8) ![commit-last](https://img.shields.io/github/last-commit/11notes/docker-traefik-labels?color=c91cb8) ![stars](https://img.shields.io/docker/stars/11notes/traefik-labels?color=e6a50e)

# SYNOPSIS
What can I do with this? This image will connect to all your Docker nodes and read their labels. It will then use the labels to update your Traefik configuration in Redis automatically and dynamically on each container start, stop or timeout. It also supports updating your internal and external DNS servers too, so you can use labels for everything. If a container is removed the image will automatically reverse any `nsupdate update add` to `nsupdate update delete` so entries are removed too.

In order to use this image, you need to setup Traefik with a Redis provider and then point this image via redis.url to the same Redis instance. Each entry will have an expire timer set in Redis, so that if a container is removed by a server crashing, Redis will automatically remove stale entries as well. Entries are refreshed every 300 seconds or on all docker container events (create, run, kill, stop, restart, ...). As for nsupdate, you need to setup tsig authentication in your NS servers and add the keys to the zones you want to be able to update, you can restrict the keys by using update-policy if you use BIND.

This image provides the ability to call a webhook for each container for each event or poll after the data was updates in Redis and or nsupdate.

# VOLUMES
* **/labels/etc** - Directory of config.yaml
* **/labels/ssl** - Directory of ssl certificates for TLS<sup>1</sup>

# CONFIG (EXAMPLE)
/labels/etc/config.yaml
```yaml
labels:
  redis:
    url: rediss://foo:bar@10.127.198.254:6379/0
  webhook:
    url: https://my.cool.webhook/v1
    # optional
    auth:
      # supports basic authentication
      basic: labels:*****
  nodes:
    # use FQDN and add the FQDN to your certificates SAN list (or IP)
    - 192.168.18.12
    - 10.14.120.1
  rfc2136:
    # only nsupdate on entries which are different (remove existing entry)
    update-only: true
  poll:
    # polling all containers on a node every {n} seconds
    interval: 300
  ping:
    # ping all nodes every {n} seconds to see if they are still online
    interval: 2.5
  tls:
    # path for TLS certificates
    ca: /labels/ssl/ca.crt
    crt: /labels/ssl/server.crt
    key: /labels/ssl/server.key
```

# RUN
```shell
docker run --name traefik-labels \
  -v .../etc:/labels/etc \
  -v .../ssl:/labels/ssl \
  -d 11notes/traefik-labels:[tag]
```

# DEFAULT SETTINGS
| Parameter | Value | Description |
| --- | --- | --- |
| `user` | docker | user docker |
| `uid` | 1000 | user id 1000 |
| `gid` | 1000 | group id 1000 |
| `home` | /labels | home directory of user docker |
| `config` | /labels/etc/config.yaml | Static config |
| `ca.crt` | /labels/ssl/ca.crt | Certificate of CA for TLS<sup>1</sup> |
| `labels.crt` | /labels/ssl/labels.crt | Certificate of client for TLS<sup>1</sup> |
| `labels.key` | /labels/ssl/labels.key | Private key of client for TLS<sup>1</sup> |

# ENVIRONMENT
| Parameter | Value | Default |
| --- | --- | --- |
| `TZ` | [Time Zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) | |
| `DEBUG` | Show debug information | |

# PARENT IMAGE
* [11notes/node:stable](https://hub.docker.com/r/11notes/node)

# BUILT WITH
* [npm::redis](https://www.npmjs.com/package/redis)
* [npm::dockerode](https://www.npmjs.com/package/dockerode)
* [nodejs](https://nodejs.org/en)
* [alpine](https://alpinelinux.org)

# TIPS
* Only use rootless container runtime (podman, rootless docker)
* Allow non-root ports < 1024 via `echo "net.ipv4.ip_unprivileged_port_start=53" > /etc/sysctl.d/ports.conf`
* Use a reverse proxy like Traefik, Nginx to terminate TLS with a valid certificate

# DISCLAIMERS
* <sup>1</sup> For TLS to work you need proper certificates in place for your dockerd and your clients. The CN in the certificate needs to match the FQDN or IP you have set on the docker node, you can set multiple by using SAN. See an example of a daemon.json configuration to enable TLS.
```json
{
  "tls": true,
  "tlsverify": true,
  "tlscacert": "/etc/docker/ca.crt",
  "tlscert": "/etc/docker/server.crt",
  "tlskey": "/etc/docker/server.key",
  "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"]
}
```

# ElevenNotes<sup>™️</sup>
This image is provided to you at your own risk. Always make backups before updating an image to a new version. Check the changelog for breaking changes.
    