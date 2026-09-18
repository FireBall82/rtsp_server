#!/bin/sh
# Generate a local CA and a server certificate for one LAN IPv4 address.
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  echo 'Usage: sh scripts/setup-https.sh <server-LAN-IPv4>' >&2
  exit 1
fi
camera_ip=$1
if ! printf '%s\n' "$camera_ip" | awk -F. '
  NF != 4 { exit 1 }
  { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || length($i) > 3 || $i > 255 || (length($i) > 1 && substr($i, 1, 1) == "0")) exit 1 }
'; then
  echo 'Provide a valid IPv4 address, for example 192.168.50.127.' >&2
  exit 1
fi

camera_project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$camera_project"
mkdir -p tls
# Preserve the CA so rerunning this script does not invalidate client trust.
if [ -f tls/ca.key ] && [ -f tls/ca.crt ]; then
  openssl x509 -in tls/ca.crt -checkend 2592000 -noout
elif [ -f tls/ca.key ] || [ -f tls/ca.crt ]; then
  echo 'Incomplete CA in tls/. Restore its matching ca.key and ca.crt before continuing.' >&2
  exit 1
else
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 1825 \
    -keyout tls/ca.key -out tls/ca.crt -subj '/CN=Camera LAN Local CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign'
fi

openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -keyout tls/server.key -out tls/server.csr -subj "/CN=$camera_ip"
cat > tls/server.ext <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$camera_ip,IP:127.0.0.1,DNS:localhost
EOF
openssl x509 -req -in tls/server.csr -CA tls/ca.crt -CAkey tls/ca.key \
  -CAcreateserial -out tls/server.crt -days 365 -sha256 -extfile tls/server.ext
openssl verify -CAfile tls/ca.crt -verify_ip "$camera_ip" tls/server.crt
# Only the public CA certificate is served. Private keys stay outside web/.
cp tls/ca.crt web/camera-ca.crt
chmod 644 tls/ca.crt tls/server.crt web/camera-ca.crt
printf '\nTrust tls/ca.crt on the capturing device, then open https://%s:8443/\n' "$camera_ip"
printf 'CA SHA-256 fingerprint (check this on the capturing device):\n'
openssl x509 -in tls/ca.crt -noout -fingerprint -sha256
