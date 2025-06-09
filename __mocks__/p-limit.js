module.exports = function pLimit() {
  return async (fn, ...args) => fn(...args);
};
