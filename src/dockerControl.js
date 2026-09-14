import Docker from "dockerode";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// Docker's container.State.Status: "created", "running", "paused",
// "restarting", "removing", "exited", "dead". Throws with statusCode 404
// if the container doesn't exist at all (e.g. removed via `docker
// compose down`, not just stopped) - callers should handle that
// specifically, since start/restart can't recreate a removed container,
// only the host running `docker compose up` can.
export async function getContainerStatus(containerName) {
  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  return {
    running: info.State.Running,
    status: info.State.Status,
    startedAt: info.State.StartedAt,
  };
}

export async function startContainer(containerName) {
  const container = docker.getContainer(containerName);
  try {
    await container.start();
  } catch (err) {
    if (err.statusCode === 304) return; // already running - not an error
    throw err;
  }
}

export async function stopContainer(containerName) {
  const container = docker.getContainer(containerName);
  try {
    await container.stop();
  } catch (err) {
    if (err.statusCode === 304) return; // already stopped - not an error
    throw err;
  }
}

// Confirmed (tested against a real stopped container): restart() succeeds
// and starts it, no special-casing needed here - callers just get to
// choose whether to say "restarting" or "starting" based on a status
// check first, for accurate messaging.
export async function restartContainer(containerName) {
  const container = docker.getContainer(containerName);
  await container.restart();
}
