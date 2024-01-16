# :: Util
  FROM alpine as util

  RUN set -ex; \
    apk add --no-cache \
      git; \
    git clone https://github.com/11notes/util.git;

# :: Header
  FROM 11notes/node:stable
  COPY --from=util /util/node/util.js /labels/lib
  ENV APP_ROOT=/labels

# :: Run
  USER root

  # :: prepare image
    RUN set -ex; \
      mkdir -p ${APP_ROOT}; \
      akp --no-cache add \
        bind-tools; \
      apk --no-cache upgrade;

  # :: install
    RUN set -ex; \
      cd ${APP_ROOT}; \
      npm --save install \
        redis@4.6.11 \
        dockerode@4.0.0;

  # :: update image
    RUN set -ex; \
      apk --no-cache upgrade;

  # :: copy root filesystem changes and set correct permissions
    COPY ./rootfs /
    RUN set -ex; \
      chmod +x -R /usr/local/bin; \
      chown -R 1000:1000 \
        ${APP_ROOT};

# :: Start
  USER docker
  ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]