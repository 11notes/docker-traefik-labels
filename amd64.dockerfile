# :: Util
  FROM alpine as util

  RUN set -ex; \
    apk add --no-cache \
      git; \
    git clone https://github.com/11notes/util.git;

# :: Header
  FROM 11notes/node:stable
  ENV APP_ROOT=/labels

# :: Run
  USER root

  # :: prepare image
    RUN set -ex; \
      mkdir -p ${APP_ROOT}/lib; \
      apk --no-cache add \
        bind-tools; \
      apk --no-cache upgrade;

    COPY --from=util /util/node/util.js /labels/lib

  # :: install
    RUN set -ex; \
      cd ${APP_ROOT}; \
      npm --save install \
        redis@4.6.11 \
        js-yaml@4.1.0 \
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