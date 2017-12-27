import trimStart from 'lodash/trimStart';
import semaphore from "semaphore";
import { fileExtension } from 'Lib/pathHelper'
import AuthenticationPage from "./AuthenticationPage";
import API from "./API";

const MAX_CONCURRENT_DOWNLOADS = 10;

export default class GitLab {
  constructor(config, proxied = false) {
    this.config = config;

    if (!proxied && config.getIn(["backend", "repo"]) == null) {
      throw new Error("The GitLab backend needs a \"repo\" in the backend configuration.");
    }

    this.repo = config.getIn(["backend", "repo"], "");
    this.branch = config.getIn(["backend", "branch"], "master").trim();
    this.gitlab_root = config.getIn(["backend", "gitlab_root"], "https://gitlab.com").trim('/');
    this.api_root = `${this.gitlab_root}/api/v4`;
    this.token = '';
  }

  authComponent() {
    return AuthenticationPage;
  }

  restoreUser(user) {
    return this.authenticate(user);
  }

  authenticate(state) {
    this.token = state.token;
    this.api = new API({ token: this.token, branch: this.branch, repo: this.repo, api_root: this.api_root });
    return this.api.user().then(user =>
      this.api.hasWriteAccess(user).then((isCollab) => {
        // Unauthorized user
        if (!isCollab) throw new Error("Your GitLab user account does not have access to this repo.");
        // Authorized user
        user.token = state.token;
        return user;
      })
    );
  }

  logout() {
    this.token = null;
    return;
  }

  getToken() {
    return Promise.resolve(this.token);
  }

  entriesByFolder(collection, extension) {
    return this.api.listFiles(collection.get("folder"))
    .then(files => files.filter(file => fileExtension(file.name) === extension))
    .then(this.fetchFiles);
  }

  entriesByFiles(collection) {
    const files = collection.get("files").map(collectionFile => ({
      path: collectionFile.get("file"),
      label: collectionFile.get("label"),
    }));
    return this.fetchFiles(files);
  }

  fetchFiles = (files) => {
    const sem = semaphore(MAX_CONCURRENT_DOWNLOADS);
    const promises = [];
    files.forEach((file) => {
      promises.push(new Promise((resolve, reject) => (
        sem.take(() => this.api.readFile(file.path, file.id).then((data) => {
          resolve({ file, data });
          sem.leave();
        }).catch((err) => {
          sem.leave();
          reject(err);
        }))
      )));
    });
    return Promise.all(promises);
  };

  // Fetches a single entry.
  getEntry(collection, slug, path) {
    return this.api.readFile(path).then(data => ({
      file: { path },
      data,
    }));
  }

  getMedia() {
    return this.api.listFiles(this.config.get('media_folder'))
      .then(files => files.filter(file => file.type === 'blob'))
      .then(files => files.map(({ id, mode, name, path }) => {
        return { id: id, name, url: `${this.gitlab_root}/${this.repo}/raw/${this.branch}/${path}`, path };
      }));
  }

  persistEntry(entry, mediaFiles = [], options = {}) {
    return this.api.persistFiles(entry, mediaFiles, options);
  }

  async persistMedia(mediaFile, options = {}) {
    try {
      const response = await this.api.persistFiles(null, [mediaFile], options);
      const repo = this.repo;
      const { value, size, path, fileObj } = mediaFile;
      const url = `${this.gitlab_root}/${repo}/raw/${this.branch}/${path}`;
      console.log(url);
      return { id: response.id, name: value, size: fileObj.size, url, path: trimStart(path, '/') };
    } catch (error) {
      throw error;
    }
  }

  deleteFile(path, commitMessage, options) {
    return this.api.deleteFile(path, commitMessage, options);
  }
}
