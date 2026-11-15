# Lunar-Landing-Site-Navigator
Official Repository for NASA Space App's London Virtual Event

Start in Moon Explorer, select one or two landing sites, and open them in Skyline V3.

## Run with Docker

With Docker Desktop or Docker Engine and Docker Compose running, open a terminal
in the repository root and run:

```sh
docker compose up --build -d --wait
```

Open [Moon Explorer](http://localhost:8080/moon.html). The first build downloads
the SPICE kernels and starter elevation maps and can take a few minutes. Higher-resolution terrain is
fetched on demand and stored in a Docker volume for subsequent runs.
If a first visit to an uncached site times out while loading shadows, click
**Update dates** with the same dates to retry.

```sh
docker compose logs -f    # View frontend and backend logs
docker compose down       # Stop the app and keep the terrain cache
```

To use a different port, set `LUNAR_PORT` in a root `.env` file, for example
`LUNAR_PORT=8081`, then rerun the startup command and open that port.

For development without Docker and for map sources, see the
[Moon Explorer and Skyline V3 guide](docs/moon_explorer.md).

## Make changes

Clone or fork the repository and check out the branch containing the version
you want to run. Create a feature branch before editing. The local development
servers reload changes to the frontend and backend. If you use Docker while
editing, rerun `docker compose up --build -d --wait` to apply changes.

Repository collaborators can push their feature branch and open a pull request.
Other contributors can push to their own fork and open a pull request from it.
