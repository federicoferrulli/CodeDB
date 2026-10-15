#!/usr/bin/env bash
set -euo pipefail
cat >/etc/krb5.conf <<'EOF'
[libdefaults]
 default_realm = CODEDB.TEST
 dns_lookup_kdc = false
 dns_lookup_realm = false
 rdns = false
[realms]
 CODEDB.TEST = {
  kdc = mongo.kerberos.test
  admin_server = mongo.kerberos.test
 }
[domain_realm]
 .kerberos.test = CODEDB.TEST
 mongo.kerberos.test = CODEDB.TEST
EOF
mkdir -p /var/lib/krb5kdc /etc/krb5kdc /data/kerberos-test
cat >/etc/krb5kdc/kdc.conf <<'EOF'
[kdcdefaults]
 kdc_ports = 88
[realms]
 CODEDB.TEST = {
  database_name = /var/lib/krb5kdc/principal
  key_stash_file = /etc/krb5kdc/stash
  acl_file = /etc/krb5kdc/kadm5.acl
 }
EOF
kdb5_util create -s -P codedb-fixture-only
kadmin.local -q 'addprinc -randkey mongodb/mongo.kerberos.test@CODEDB.TEST'
kadmin.local -q 'ktadd -k /tmp/mongodb.keytab mongodb/mongo.kerberos.test@CODEDB.TEST'
kadmin.local -q 'addprinc -randkey codedb@CODEDB.TEST'
kadmin.local -q 'ktadd -k /tmp/client.keytab codedb@CODEDB.TEST'
krb5kdc
mongod --dbpath /data/kerberos-test --bind_ip_all --logpath /tmp/mongod.log --fork --wiredTigerCacheSizeGB 0.25
mongosh --quiet --eval 'db.getSiblingDB("$external").createUser({user:"codedb@CODEDB.TEST",roles:[{role:"root",db:"admin"}]})'
mongod --dbpath /data/kerberos-test --shutdown
KRB5_KTNAME=/tmp/mongodb.keytab mongod --dbpath /data/kerberos-test --bind_ip_all --logpath /tmp/mongod.log --fork --auth --setParameter authenticationMechanisms=GSSAPI --wiredTigerCacheSizeGB 0.25
kinit -kt /tmp/client.keytab codedb@CODEDB.TEST
node test/e2e-mongosh-kerberos.cjs
