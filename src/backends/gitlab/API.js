import LocalForage from "localforage";
import { Base64 } from "js-base64";
import AssetProxy from "ValueObjects/AssetProxy";
import { APIError } from "ValueObjects/errors";

export default class API {
  constructor(config) {
    this.api_root = config.api_root || "https://gitlab.com/api/v4";
    this.token = config.token || false;
    this.branch = config.branch || "master";
    this.repo = config.repo || "";
    this.per_page = config.per_page || 50;
    this.repoURL = `/projects/${ encodeURIComponent(this.repo) }`;
  }

  user() {
    return this.request("/user");
  }

  isGroupProject() {
    return this.request(this.repoURL)
      .then(({ namespace }) => (namespace.kind === "group" ? `/groups/${ encodeURIComponent(namespace.full_path) }` : false));
  }

  hasWriteAccess(user) {
    const WRITE_ACCESS = 30;
    return this.isGroupProject().then((group) => {
      if (group === false) {
        return this.request(`${ this.repoURL }/members/${ user.id }`);
      } else {
        return this.request(`${ group }/members/${ user.id }`);
      }
    })
    .then(member => (member.access_level >= WRITE_ACCESS))
    .catch((err) => {
      // Member does not have any access. We cannot just check for 404,
      //   because a 404 is also returned if we have the wrong URI,
      //   just with an "error" key instead of a "message" key.
      if (err.status === 404 && err.meta.errorValue["message"] === "404 Not found") {
        return false;
      } else {
        // Otherwise, it is actually an API error.
        throw err;
      }
    });
  }

  requestHeaders(headers = {}) {
    const baseHeader = {
      "Content-Type": "application/json",
      ...headers,
    };

    if (this.token) {
      baseHeader.Authorization = `Bearer ${ this.token }`;
      return baseHeader;
    }

    return baseHeader;
  }

  parseJsonResponse(response) {
    return response.json().then((json) => {
      if (!response.ok) {
        return Promise.reject(json);
      }

      return json;
    });
  }

  urlFor(path, options) {
    const cacheBuster = new Date().getTime();
    const params = [`ts=${cacheBuster}`];
    if (options.params) {
      for (const key in options.params) {
        params.push(`${ key }=${ encodeURIComponent(options.params[key]) }`);
      }
    }
    if (params.length) {
      path += `?${ params.join("&") }`;
    }
    return this.api_root + path;
  }

  request(path, options = {}, previousData = null) {
    const headers = this.requestHeaders(options.headers || {});
    const url = this.urlFor(path, options);
    let responseStatus;
    let data;

    return fetch(url, { ...options, headers }).then((response) => {
      responseStatus = response.status;
      const headers = response.headers;
      const contentType = headers.get("Content-Type");

      if (contentType && contentType.match(/json/)) {
        data = Object.assign(previousData !== null ? previousData : {}, this.parseJsonResponse(response));
      } else {
        data = (previousData !== null ? previousData : '') + response.text();
      }

      console.log(data);

      if (headers.has('x-next-page') && headers.get('x-next-page') !== "") {
        options.params = Object.assign({}, options.params || {}, { page: headers.get('x-next-page') });
        console.log(path, options);
        return this.request(path, options, data);
      }

      return data;
    })
    .catch((error) => {
      throw new APIError(error.message, responseStatus, 'GitHub');
    });
  }

  readFile(path, id, branch = this.branch) {
    const cache = id ? LocalForage.getItem(`gl.${ id }`) : Promise.resolve(null);
    return cache.then((cached) => {
      if (cached) { return cached; }

      return this.request(`${ this.repoURL }/repository/files/${ encodeURIComponent(path) }`, {
        params: { ref: branch },
        cache: "no-store",
      }).then(response => this.fromBase64(response.content))
        .then((result) => {
          if (id) {
            LocalForage.setItem(`gl.${ id }`, result);
          }
          return result;
        });
    });
  }

  listFiles(path) {
    return this.request(`${ this.repoURL }/repository/tree`, {
      params: { path, ref: this.branch, per_page: this.per_page },
    })
    .then((files) => {
      if (!Array.isArray(files)) {
        throw new Error(`Cannot list files, path ${path} is not a directory but a ${files.type}`);
      }
      return files;
    })
    .then(files => files.filter(file => file.type === "blob"));
  }

  fileExists(path, branch = this.branch) {
    return this.request(`${ this.repoURL }/repository/files/${ encodeURIComponent(path) }`, {
      method: "HEAD",
      params: { ref: branch },
      cache: "no-store",
    }).then(() => true).catch(err =>
      // 404 can mean either the file does not exist, or if an API
      //   endpoint doesn't exist. We can't check this becaue we are
      //   not getting the content with a HEAD request.
      (err.status === 404 ? false : Promise.reject(err))
    );
  }

  persistFiles(entry, mediaFiles, options) {
    const newMedia = mediaFiles.filter(file => !file.uploaded);
    const mediaUploads = newMedia.map(file => this.fileExists(file.path).then((exists) => {
      return this.uploadAndCommit(file, {
        commitMessage: `${ options.commitMessage }: create ${ file.value }.`,
        newFile: !exists,
      });
    }));

    // Wait until media files are uploaded before we commit the main entry.
    //   This should help avoid inconsistent repository/website state.
    return Promise.all(mediaUploads)
    .then(() => this.uploadAndCommit(entry, {
      commitMessage: options.commitMessage,
      newFile: options.newEntry,
    }));
  }

  deleteFile(path, message, options={}) {
    const branch = options.branch || this.branch;
    return this.request(`${ this.repoURL }/repository/files/${ encodeURIComponent(path) }`, {
      method: "DELETE",
      params: { message, branch },
    });
  }

  toBase64(str) {
    return Promise.resolve(
      Base64.encode(str)
    );
  }

  fromBase64(str) {
    return Base64.decode(str);
  }

  uploadAndCommit(item, { commitMessage, newFile = true, branch = this.branch }) {
    const content = item instanceof AssetProxy ? item.toBase64() : this.toBase64(item.raw);
    // Remove leading slash from path if exists.
    const filePath = item.path.replace(/^\//, '');

    // We cannot use the `/repository/files/:file_path` format here because the file content has to go
    //   in the URI as a parameter. This overloads the OPTIONS pre-request (at least in Chrome 61 beta).
    return content.then(contentBase64 => this.request(`${ this.repoURL }/repository/commits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        branch: branch,
        commit_message: commitMessage,
        actions: [{
          action: (newFile ? "create" : "update"),
          file_path: filePath,
          content: contentBase64,
          encoding: "base64",
        }]
      }),
    })).then(response => Object.assign({}, item, { uploaded: true }));
  }
}
