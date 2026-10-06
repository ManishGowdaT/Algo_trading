// Replace only the Mongo collection boundary; exercise real models, middleware,
// casting, immutable snapshots, optimistic saves and query update paths.
const mongoose = require('mongoose');
function copy(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof mongoose.Types.ObjectId) return new mongoose.Types.ObjectId(String(value));
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(copy);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
}
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(item => matches(row, item));
    if (key === '$and') return expected.every(item => matches(row, item));
    const actual = key.split('.').reduce((value, part) => value?.[part], row);
    if (expected && typeof expected === 'object' && !(expected instanceof mongoose.Types.ObjectId) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, value]) => op === '$exists' ? (actual !== undefined && actual !== null) === value
        : op === '$in' ? value.some(item => String(item) === String(actual))
          : op === '$nin' ? !value.some(item => String(item) === String(actual))
            : op === '$gt' ? actual > value
            : op === '$gte' ? actual >= value
              : op === '$lt' ? actual < value
                : op === '$lte' ? actual <= value
            : op === '$ne' ? String(actual) !== String(value) : false);
    }
    return String(actual) === String(expected);
  });
}
function set(row, path, value) {
  const parts = path.split('.'); let target = row;
  while (parts.length > 1) { const key = parts.shift(); target = target[key] ||= {}; }
  target[parts[0]] = copy(value);
}
function update(row, mutation) {
  for (const [path, value] of Object.entries(mutation.$set || {})) set(row, path, value);
  for (const [path, value] of Object.entries(mutation.$inc || {})) set(row, path, (row[path] || 0) + value);
  for (const path of Object.keys(mutation.$unset || {})) delete row[path];
  for (const [path, value] of Object.entries(mutation.$push || {})) row[path] = [...(row[path] || []), ...copy(value.$each || [value])];
}
function collections(t, models, seeds = {}) {
  const stores = {};
  for (const Model of models) {
    const records = stores[Model.modelName] = copy(seeds[Model.modelName] || []);
    const boundary = Model.collection;
    const originals = {};
    const inject = { fail: null, writes: [], reads: [] };
    const checkFailure = write => {
      const failure = typeof inject.fail === 'function' ? inject.fail(write) : inject.fail;
      if (failure) throw new Error(failure);
    };
    stores[`${Model.modelName}Control`] = inject;
    for (const method of ['findOne', 'find', 'insertOne', 'updateOne', 'findOneAndUpdate', 'indexes', 'createIndex']) originals[method] = boundary[method];
    boundary.findOne = async filter => { inject.reads.push(copy(filter)); return copy(records.find(row => matches(row, filter)) || null); };
    boundary.find = filter => ({ toArray: async () => copy(records.filter(row => matches(row, filter))) });
    boundary.insertOne = async row => {
      checkFailure(row);
      if (records.some(item => String(item._id) === String(row._id))) throw Object.assign(new Error('Duplicate ID'), { code: 11000 });
      records.push(copy(row)); inject.writes.push(['insert', copy(row)]); return { acknowledged: true, insertedId: row._id };
    };
    boundary.updateOne = async (filter, mutation) => {
      checkFailure(mutation);
      const row = records.find(item => matches(item, filter));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      update(row, mutation); inject.writes.push(['update', copy(mutation)]); return { matchedCount: 1, modifiedCount: 1 };
    };
    boundary.findOneAndUpdate = async (filter, mutation) => {
      checkFailure(mutation);
      const row = records.find(item => matches(item, filter));
      if (!row) return null;
      update(row, mutation); inject.writes.push(['update', copy(mutation)]); return copy(row);
    };
    boundary.indexes = async () => Model.schema.indexes().map(([key, options]) => ({ key, ...options }));
    boundary.createIndex = async (keys, options) => { inject.createdIndexes ||= []; inject.createdIndexes.push({ keys: copy(keys), options: copy(options) }); return options?.name || 'test-index'; };
    t.after(() => Object.assign(boundary, originals));
  }
  return stores;
}
module.exports = { collections, copy, matches };
