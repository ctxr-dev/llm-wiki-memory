import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  embed,
  embedMany,
  activeBackend,
  __setBackendStateForTest,
  __setWorkerFactoryForTest,
} from "../scripts/lib/embed.mjs";
import { withSettingsOverride } from "../scripts/lib/settings.mjs";

function makeFakeWorker(reply) {
  const listeners = new Map();
  const worker = {
    postMessage(msg) {
      queueMicrotask(() => reply(msg, worker));
    },
    on(event, cb) {
      listeners.set(event, cb);
    },
    emit(event, arg) {
      listeners.get(event)?.(arg);
    },
    ref() {},
    unref() {},
    terminate() {},
  };
  return worker;
}

after(() => {
  __setWorkerFactoryForTest(null);
  __setBackendStateForTest();
});

test("embedMany routes through the worker and resolves its vectors", async () => {
  __setBackendStateForTest();
  __setWorkerFactoryForTest(() =>
    makeFakeWorker((msg, worker) => {
      worker.emit("message", { id: msg.id, ok: true, vectors: msg.texts.map((t, i) => [i, t.length]) });
    }),
  );
  await withSettingsOverride({ embed: { backend: "transformers", model: "test/plain-model" } }, async () => {
    const vectors = await embedMany(["ab", "cdef"]);
    assert.deepEqual(vectors, [
      [0, 2],
      [1, 4],
    ]);
    assert.equal(activeBackend(), "transformers");
  });
});

test("embed() delegates through the worker path", async () => {
  __setBackendStateForTest();
  __setWorkerFactoryForTest(() =>
    makeFakeWorker((msg, worker) => {
      worker.emit("message", { id: msg.id, ok: true, vectors: [[0.5, 0.25]] });
    }),
  );
  await withSettingsOverride({ embed: { backend: "transformers", model: "test/plain-model" } }, async () => {
    assert.deepEqual(await embed("hello"), [0.5, 0.25]);
  });
});

test("a worker error falls back to lexical vectors and opens the retry window", async () => {
  __setBackendStateForTest();
  __setWorkerFactoryForTest(() =>
    makeFakeWorker((msg, worker) => {
      worker.emit("message", { id: msg.id, ok: false, error: "boom" });
    }),
  );
  await withSettingsOverride({ embed: { backend: "transformers", model: "test/plain-model" } }, async () => {
    const vectors = await embedMany(["hello world"]);
    assert.equal(vectors.length, 1);
    assert.ok(Array.isArray(vectors[0]) && vectors[0].length > 0);
    assert.equal(activeBackend(), "lexical");
  });
});

test("a dead worker rejects only its own requests; a successor worker serves fresh ones", async () => {
  __setBackendStateForTest();
  let spawned = 0;
  __setWorkerFactoryForTest(() => {
    spawned += 1;
    if (spawned === 1) {
      return makeFakeWorker((msg, worker) => {
        worker.emit("exit", 1);
      });
    }
    return makeFakeWorker((msg, worker) => {
      worker.emit("message", { id: msg.id, ok: true, vectors: [[9]] });
    });
  });
  await withSettingsOverride({ embed: { backend: "transformers", model: "test/plain-model" } }, async () => {
    const degraded = await embedMany(["first"]);
    assert.equal(activeBackend(), "lexical", "worker death degrades to lexical");
    assert.equal(degraded.length, 1);

    __setBackendStateForTest();
    const recovered = await embedMany(["second"]);
    assert.deepEqual(recovered, [[9]]);
    assert.equal(activeBackend(), "transformers");
    assert.equal(spawned, 2, "a replacement worker was spawned");
  });
});

test("EmbeddingGemma retrieval prompts reach the worker; hashes upstream stay raw", async () => {
  __setBackendStateForTest();
  const seen = [];
  __setWorkerFactoryForTest(() =>
    makeFakeWorker((msg, worker) => {
      seen.push(...msg.texts);
      worker.emit("message", { id: msg.id, ok: true, vectors: msg.texts.map(() => [1]) });
    }),
  );
  await withSettingsOverride(
    { embed: { backend: "transformers", model: "onnx-community/embeddinggemma-300m-ONNX" } },
    async () => {
      await embed("kafka decision", "query");
      await embedMany(["a leaf body"]);
      assert.equal(seen[0], "task: search result | query: kafka decision");
      assert.equal(seen[1], "title: none | text: a leaf body");
    },
  );
});

test("a genuinely lexical config never touches the worker", async () => {
  __setBackendStateForTest();
  let spawned = 0;
  __setWorkerFactoryForTest(() => {
    spawned += 1;
    return makeFakeWorker(() => {});
  });
  await withSettingsOverride({ embed: { backend: "lexical" } }, async () => {
    const vectors = await embedMany(["a", "b"]);
    assert.equal(vectors.length, 2);
    assert.equal(spawned, 0);
    assert.equal(activeBackend(), "lexical");
  });
});
