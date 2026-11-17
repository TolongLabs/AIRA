# Off-Host Backup Destination

Set-up kit for running `restic/rest-server` in append-only mode on the
destination host. Never expose this service to the public internet; bind it to
the private-network address only.

## Set-Up Steps

1.  Create a working folder on the destination host, copy `compose.yml` and
    `prune.sh` into it, and create `./data`:

    ```bash
    mkdir -p data
    ```

2.  Create `.env` beside `compose.yml` with the private-network IP address to
    bind (there is no default address):

    ```dotenv
    OFFSITE_BIND=<destination-private-ip>
    OFFSITE_DATA_DIR=./data
    ```

3.  Create the htpasswd user for `dev2` (replace `<username>` with a
    repository user name such as `aira`):

    ```bash
    htpasswd -B -c ./data/.htpasswd <username>
    chmod 600 ./data/.htpasswd
    ```

    If `htpasswd` is not installed on the host:

    ```bash
    docker run --rm -i httpd:2-alpine htpasswd -nB <username> > ./data/.htpasswd
    chmod 600 ./data/.htpasswd
    ```

4.  Start the server:

    ```bash
    docker compose up -d
    ```

5.  Add these values to `dev2`'s `.env` (keep mode `600`):

    ```dotenv
    AIRA_BACKUP_PASSWORD=<strong-repository-encryption-password>
    RESTIC_REST_USERNAME=<username>
    RESTIC_REST_PASSWORD=<htpasswd-password>
    ```

6.  Set `backup.offsite` in `dev2`'s `config.yml`:

    ```yaml
    backup:
      everyMin: 15
      keepDays: 14
      offsite:
        kind: 'rest'
        repository: 'rest:http://<destination-private-ip>:8000/<username>'
        checkEveryHours: 24
        staleAlertMin: 60
    ```

7.  Schedule `prune.sh` on the destination host against the direct repository
    path (for example via cron or a systemd timer), with `RESTIC_PASSWORD` or
    `RESTIC_PASSWORD_FILE` set:

    ```bash
    RESTIC_PASSWORD=<strong-repository-encryption-password> ./prune.sh ./data/<username>
    ```
