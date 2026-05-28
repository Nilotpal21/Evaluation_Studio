const { context } = require('@opentelemetry/api');

function setLogContext(contextData, fn) {
  let ctx = context.active();
  for (const [key, value] of Object.entries(contextData)) {
    ctx = ctx.setValue(key, value);
  }
  return context.with(ctx, fn);
}

function getLogContext() {
  return context.active();
}

module.exports = { setLogContext, getLogContext };
