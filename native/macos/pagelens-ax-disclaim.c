// Spawn a helper that is its own TCC responsible process.
// AXIsProcessTrusted follows the responsible pid. An ordinary child inherits
// this host (Herdr is trusted, a Chrome-owned native host is not). The helper
// stays outside this binary so neither app cdhash changes.
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attr, int disclaim);
int responsibility_get_pid_responsible_for_pid(int pid);

static char **childEnviron(void) {
  const char *shim = getenv("PAGELENS_CHILD_DYLD");
  if (!shim || !shim[0]) return environ;
  int count = 0;
  while (environ[count]) count++;
  char **out = calloc((size_t)count + 2, sizeof(char *));
  if (!out) return NULL;
  int j = 0;
  for (int i = 0; i < count; i++) {
    if (strncmp(environ[i], "PAGELENS_CHILD_DYLD=", 20) == 0) continue;
    if (strncmp(environ[i], "DYLD_INSERT_LIBRARIES=", 22) == 0) continue;
    out[j++] = environ[i];
  }
  size_t bytes = strlen(shim) + 23;
  char *pair = malloc(bytes);
  if (!pair) return NULL;
  snprintf(pair, bytes, "DYLD_INSERT_LIBRARIES=%s", shim);
  out[j++] = pair;
  out[j] = NULL;
  return out;
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  posix_spawnattr_t attr;
  posix_spawn_file_actions_t actions;
  if (posix_spawnattr_init(&attr) != 0) return 1;
  if (posix_spawn_file_actions_init(&actions) != 0) return 1;
  if (responsibility_spawnattrs_setdisclaim(&attr, 1) != 0) {
    fprintf(stderr, "setdisclaim failed\n");
    return 1;
  }
  if (posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) != 0) return 1;
  if (posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) != 0) return 1;
  if (posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) != 0) return 1;
  char **envp = childEnviron();
  if (!envp) return 1;
  pid_t pid = 0;
  int spawned = posix_spawn(&pid, argv[1], &actions, &attr, &argv[1], envp);
  if (spawned != 0 || pid <= 0) {
    fprintf(stderr, "spawn failed errno=%d\n", spawned);
    return 1;
  }
  int responsible = responsibility_get_pid_responsible_for_pid((int)pid);
  if (responsible != (int)pid) {
    kill(pid, SIGTERM);
    fprintf(stderr, "responsible=%d pid=%d\n", responsible, (int)pid);
    return 1;
  }
  fprintf(stdout, "%d\n", (int)pid);
  return 0;
}
