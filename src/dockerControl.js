import Docker from "dockerode";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

export async function restartContainer(containerName) {
  const container = docker.getContainer(containerName);
  await container.restart();
}

export async function getContainerStatus(containerName) {
  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  return {
    running: info.State.Running,
    startedAt: info.State.StartedAt,
  };
}
