# Alpine :: Traefik Labels
![size](https://img.shields.io/docker/image-size/11notes/traefik-labels/amd64-0.1.9?color=0eb305) ![version](https://img.shields.io/docker/v/11notes/traefik-labels/amd64-0.1.9?color=eb7a09) ![pulls](https://img.shields.io/docker/pulls/11notes/traefik-labels?color=2b75d6) ![activity](https://img.shields.io/github/commit-activity/m/11notes/docker-traefik-labels?color=c91cb8) ![commit-last](https://img.shields.io/github/last-commit/11notes/docker-traefik-labels?color=c91cb8)

Run Traefik Labels based on Alpine Linux. Small, lightweight, secure and fast 🏔️

## Description
What can I do with this? Simply put: It will export any traefik labels on a container on the same host as this image runs to a Redis instance. This makes it possible for a centralized Traefik load balancer to update endpoints dynamically by utilizing the docker labels, just like you would on a local installation of Traefik with labels. It is meant as an alternative and simple way to proxy requests from a Traefik load balancer to multiple docker nodes running in different networks and locations. The image has the ability to use nsupdate with labels too, so that not only you can add a dynamic proxy to your Traefik, but add DNS entries to your internal or external NS servers. It uses split DNS as WAN and LAN in your labels, so you can update external as well as internal DNS entries on the fly. If a container is removed the image will automatically reverse any `nsupdate update add` to `nsupdate update delete` so entrie are removed too.

In order to use this image, you need to setup Traefik with a Redis provider and then point this image via REDIS_URL to the same Redis instance. Each entry will have an expire timer set in Redis, so that if a container is removed by a server crashing, Redis will automatically remove stale entries as well. Entries are refreshed every 300 seconds or on all docker container events (create, run, kill, stop, restart, ...). As for nsupdate, you need to setup tsig authentication in your NS servers and add the keys to the zones you want to be able to update, you can restrict the keys by using update-policy if you use BIND.

This image provides the ability to call a webhook for each container for each event or poll after the data was updates in Redis and or nsupdate.

## Run
```shell
docker run --name traefik-labels \
  -v /run/docker.sock:/run/docker.sock \
  -e LABELS_REDIS_URL="rediss://foo:bar@10.127.198.254:6379/0" \
  -d 11notes/traefik-labels:[tag]
```

```shell
docker run --name traefik-labels \
  -v /run/docker.sock:/run/docker.sock \
  -e LABELS_REDIS_URL="rediss://foo:bar@10.127.198.254:6379/0" \
  -e LABELS_WEBHOOK="https://domain.com/traefik/labels" \
  -e LABELS_WEBHOOK_AUTH_BASIC="foo:bar" \
  -d 11notes/traefik-labels:[tag]
```

## Examples
```shell
docker run --name traefik-demo \
  -p 8080:8080 \
  -l "traefik/http/routers/demo.domain.com/service=demo.domain.com" \
  -l "traefik/http/routers/demo.domain.com/rule=Host(`demo.domain.com`)" \
  -l "traefik/http/routers/demo.domain.com/tls=true" \
  -l "traefik/http/routers/demo.domain.com/entrypoints=https" \
  -l "traefik/http/services/demo.domain.com/loadbalancer/servers/0/url=http://fqdn-of-docker-node:8080" \
  -d 11notes/nginx:stable
```

```shell
docker run --name traefik-rfc2136-demo \
  -p 8080:8080 \
  -l "traefik/http/routers/demo.domain.com/service=demo.domain.com" \
  -l "traefik/http/routers/demo.domain.com/rule=Host(`demo.domain.com`)" \
  -l "traefik/http/routers/demo.domain.com/tls=true" \
  -l "traefik/http/routers/demo.domain.com/entrypoints=https" \
  -l "traefik/http/services/demo.domain.com/loadbalancer/servers/0/url=http://fqdn-of-docker-node:8080" \
  -l "rfc2136/WAN/server=ns.domain.com" \
  -l "rfc2136/WAN/key=algo:name:secret" \
  -l "rfc2136/WAN/nsupdate=update add foo.domain.com 300 A 175.12.41.11" \
  -l "rfc2136/WAN/nsupdate=update add foo.domain.com 300 TXT \"hello from traefik-labels!\"" \
  -l "rfc2136/LAN/server=ns.domain.local" \
  -l "rfc2136/LAN/key=algo:name:secret" \
  -l "rfc2136/LAN/nsupdate=update add foo.domain.local 300 A 192.168.12.54" \
  -d 11notes/nginx:stable
```

## Defaults
| Parameter | Value | Description |
| --- | --- | --- |
| `user` | docker | user docker |
| `uid` | 1000 | user id 1000 |
| `gid` | 1000 | group id 1000 |
| `home` | /labels | home directory of user docker |
| `api` | https://${IP}:5000 | HTTPS endpoint of Docker registry |

## Environment
| Parameter | Value | Default |
| --- | --- | --- |
| `TZ` | [Time Zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) | null |
| `LABELS_REDIS_URL` | the redis URL to connect, use rediss:// for SSL | rediss://localhost:6379/0 |
| `LABELS_INTERVAL` | in what interval container information is pulled in seconds | 300 |
| `LABELS_TIMEOUT` | how many seconds after an interval the keys should stay till they expire in seconds | 30 |
| `LABELS_WEBHOOK` | URL to call on each event or poll for each container |  |
| `LABELS_WEBHOOK_AUTH_BASIC` | Basic authentication to use in the form of "username:password" for the webhook |  |
| `LABELS_RFC2136_ONLY_UPDATE_ON_CHANGE` | Only update DNS entries if they are new or changed (will use dig on each call to the set server) | false |

## Parent image
* [11notes/node:stable](https://hub.docker.com/r/11notes/node)

## Built with (thanks to)
* [npm::redis](https://www.npmjs.com/package/redis)
* [npm::dockerode](https://www.npmjs.com/package/dockerode)
* [nodejs](https://nodejs.org/en)
* [Alpine Linux](https://alpinelinux.org)

## Tips
* Only use rootless container runtime (podman, rootless docker)
* Don't bind to ports < 1024 (requires root), use NAT/reverse proxy (haproxy, traefik, nginx)
* Do not access docker.sock as root