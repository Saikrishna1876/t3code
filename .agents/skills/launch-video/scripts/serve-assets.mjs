import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

function isInside(root, file) {
  const relative = NodePath.relative(root, file);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

export function serveAssets(root, contentType, prefix = "/") {
  const directory = NodeFS.realpathSync(root);
  return async (request, response) => {
    let file;
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (!pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      file = NodePath.join(directory, decodeURIComponent(pathname.slice(prefix.length)));
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!isInside(directory, file)) {
      response.writeHead(403).end();
      return;
    }
    let body;
    try {
      const resolved = await NodeFSP.realpath(file);
      if (!isInside(directory, resolved)) {
        response.writeHead(403).end();
        return;
      }
      body = await NodeFSP.readFile(resolved);
    } catch {
      response.writeHead(404).end();
      return;
    }
    const type = contentType(file);
    response.writeHead(200, type ? { "content-type": type } : {}).end(body);
  };
}
