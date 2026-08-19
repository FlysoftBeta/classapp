import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { UnitOfWork } from "@/server/runtime/unitOfWork";

test("UnitOfWork rolls back nested writes and drops after-commit effects", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
  const unit = new UnitOfWork(db);
  const effects: string[] = [];

  assert.throws(() =>
    unit.run(() => {
      db.prepare("INSERT INTO values_table VALUES (1)").run();
      unit.afterCommit(() => effects.push("published"));
      throw new Error("rollback");
    }),
  );

  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS value FROM values_table").get() as {
        value: number;
      }
    ).value,
    0,
  );
  assert.deepEqual(effects, []);
  db.close();
});

test("UnitOfWork publishes effects only after the outer transaction commits even without an EventBus", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
  const unit = new UnitOfWork(db);
  const observedCounts: number[] = [];

  unit.run(() => {
    db.prepare("INSERT INTO values_table VALUES (1)").run();
    unit.run(() => {
      db.prepare("INSERT INTO values_table VALUES (2)").run();
      unit.afterCommit(() => {
        observedCounts.push(
          (
            db.prepare("SELECT COUNT(*) AS value FROM values_table").get() as {
              value: number;
            }
          ).value,
        );
      });
    });
    assert.deepEqual(observedCounts, []);
  });

  assert.deepEqual(observedCounts, [2]);
  db.close();
});
