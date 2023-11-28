# Alpine :: Traefik Labels
![size](https://img.shields.io/docker/image-size/11notes/traefik-labels/0.1.0?color=0eb305) ![version](https://img.shields.io/docker/v/11notes/traefik-labels?color=eb7a09) ![pulls](https://img.shields.io/docker/pulls/11notes/traefik-labels?color=2b75d6) ![activity](https://img.shields.io/github/commit-activity/m/11notes/docker-traefik-labels?color=c91cb8) ![commit-last](https://img.shields.io/github/last-commit/11notes/docker-traefik-labels?color=c91cb8)

Run Traefik Labels based on Alpine Linux. Small, lightweight, secure and fast 🏔️

What can I do with this? Simply put: It will export any traefik labels on a container on the same host as this image runs to a Redis instance. This makes it possible for a centralized Traefik load balancer to update endpoints dynamically by utilizing the docker labels, just like you would on a local installation of Traefik with labels. It is meant as an alternative and simple way to proxy requests from a Traefik load balanacer to multiple docker nodes running in different networks and locations.

In order to use this image, you need to setup Traefik with a Redis provider and then point this image via REDIS_URL to the same Redis instance. Each entry will have an expire timer set in Redis, so that if a container is removed by a server crashing, Redis will automatically remove stale entries as well. Entries are refreshed every 60 seconds or an all docker container events (create, run, kill, stop, restart, ...).

## Run
This will export all labels from all containers to the Redis instance specified in LABELS_REDIS_URL from the same host this container is running on.
```shell
docker run --name traefik-labels \
  -v /run/docker.sock:/run/docker.sock \
  -e LABELS_REDIS_URL="rediss://foo:bar@10.127.198.254:6379/0" \
  -d 11notes/traefik-labels:[tag]
```

This is a demo webserver that will start on :8080, all the traefik labels will be exportet to the Redis instance. They follow the exact same [syntax](https://doc.traefik.io/traefik/routing/providers/kv/) as for normal Redis and Traefik, just as labels.
```shell
docker run --name demo \
  -p 8080:8080 \
  -l "traefik/http/routers/demo.domain.com/service=demo.domain.com" \
  -l "traefik/http/routers/demo.domain.com/rule=Host(`demo.domain.com`)" \
  -l "traefik/http/routers/demo.domain.com/tls=true" \
  -l "traefik/http/routers/demo.domain.com/entrypoints=https" \
  -l "traefik/http/services/demo.domain.com/loadbalancer/servers/0/url=http://fqdn-of-docker-node:8080" \
  -d 11notes/nginx:stable
```

## Defaults
| Parameter | Value | Description |
| --- | --- | --- |
| `user` | docker | user docker |
| `uid` | 1000 | user id 1000 |
| `gid` | 1000 | group id 1000 |
| `home` | /labels | home directory of user docker |

## Environment
| Parameter | Value | Default |
| --- | --- | --- |
| `LABELS_REDIS_URL` | the redis URL to connect, use rediss:// for SSL | redis:://localhost:6379/0 |
| `LABELS_INTERVAL` | in what interval container information is pulled | 60 |
| `LABELS_TIMEOUT` | how many seconds after an interval the keys should stay till they expire | 15 |

## Example
```mermaid
flowchart TB
    
    subgraph Edge
        A[WAN]:::WAN -->|:8443| B(keepalived VIP):::KEEPALIVED
    end
    
    subgraph Domain_B
    B -->|:8443| C(Traefik):::TRAEFIK
    C -->|:6379| E(Redis):::REDIS
    end
    subgraph Domain_A
    B -->|:8443| D(Traefik):::TRAEFIK
    D -->|:6379| F(Redis):::REDIS
    end
    subgraph Docker_Nodes
        id1[Node 1]
        id2[Node 2]
        idn[Node n]
    end

    Domain_A -->|:8443| Docker_Nodes
    Domain_B --> |:8443|Docker_Nodes

    classDef WAN fill:#000000,stroke:none,color#FFF
    classDef KEEPALIVED fill:#CC9933,stroke:none,color#000
    classDef TRAEFIK fill:#3399CC,stroke:none,color:#FFF
    classDef REDIS fill:#AA0000,stroke:none,color:#FFF

```


## Parent image
* [11notes/node:stable](https://github.com/11notes/docker-node)

## Built with and thanks to
* [nodejs](https://nodejs.org/en)
* [Alpine Linux](https://alpinelinux.org)

## Tips
* Only use rootless container runtime (podman, rootless docker)
* Don't bind to ports < 1024 (requires root), use NAT/reverse proxy (haproxy, traefik, nginx)
* Do not access docker.sock as root