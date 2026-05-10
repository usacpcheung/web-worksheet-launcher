import { zip as zipCallback, unzip as unzipCallback } from '../vendor/fflate.module.js';

function toPromise(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(data);
    });
  });
}

export function zip(sources, options) {
  return toPromise(zipCallback, sources, options ?? {});
}

export function unzip(data, options) {
  return toPromise(unzipCallback, data, options ?? {});
}
