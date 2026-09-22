'use client';

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { Field, useSyncedText } from '@/components/designer/fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TRANSFORM_METHODS, isTransformMethod } from '@/lib/apis/auth';
import {
  describeMethods,
  hasMethod,
  moveBy,
  removeAt,
  replaceAt,
  toggleMethod,
  withMethods,
  type AnyRule,
  type RuleHelp,
  type RuleProblems,
} from '@/lib/apis/rules';

/** What a kind adds to a rule's pattern (and methods): a rewrite, a status, a rate… */
export type RuleExtra<R extends AnyRule> = (props: {
  rule: R;
  onChange: (rule: R) => void;
  /** The rule's DOM id prefix, for its inputs. */
  id: string;
  problems: RuleProblems;
  help: RuleHelp;
}) => React.ReactNode;

export type RuleListProps<R extends AnyRule> = {
  /** DOM id prefix: the field name, or e.g. `v2.allow_paths` in a version override. */
  id: string;
  label: string;
  help: string;
  /**
   * The rules. On the base definition, absent means none. In a version
   * override (`inherited` given), absent or `null` inherits the base's rules
   * and `[]` clears them for that version (`VersioningConfig::apply`).
   */
  value: readonly R[] | null | undefined;
  /**
   * Given only for a version override: the base definition's rules. The list
   * then starts as "inherited from base" and can be overridden or put back.
   */
  inherited?: readonly R[] | null | undefined;
  /** The new list. On the base, none left is `undefined`; in an override it stays `[]`. */
  onChange: (value: R[] | undefined) => void;
  /** A new rule of this kind (`newRule(list, listenPath)`). */
  newRule: () => R;
  /** Per rule, by index (`problemsOf(problems, list)`). */
  problems: readonly (RuleProblems | undefined)[];
  ruleHelp: RuleHelp;
  /** What an empty list means, in words ("Every path is allowed."). */
  empty: string;
  /** Whether the kind has `methods` (URL rewrites do not). */
  methods?: boolean;
  /** The kind's own settings (`RewriteExtra`, `MockExtra`, `RateExtra`); a stable component. */
  extra?: RuleExtra<R>;
  readOnly: boolean;
};

/**
 * An ordered list of regex path rules: the shared editor behind allow/block/
 * ignore paths, URL rewrites, mock responses and endpoint rate limits. Order
 * is precedence — the first matching rule wins — so rules move up and down
 * rather than being sorted.
 */
export function RuleList<R extends AnyRule>({
  id,
  label,
  help,
  value,
  inherited,
  onChange,
  newRule,
  problems,
  ruleHelp,
  empty,
  methods = true,
  extra,
  readOnly,
}: RuleListProps<R>) {
  const override = inherited !== undefined;
  const inheriting = override && (value === undefined || value === null);
  const rules = inheriting ? (inherited ?? []) : (value ?? []);
  const set = (next: R[]) => onChange(next.length === 0 && !override ? undefined : next);

  return (
    <div id={id} className="flex flex-col gap-3 md:col-span-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{label}</span>
          {help && <p className="text-xs text-muted">{help}</p>}
        </div>
        {override && !readOnly && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0"
            onClick={() => onChange(inheriting ? [...(inherited ?? [])] : undefined)}
          >
            {inheriting ? 'Override for this version' : 'Inherit from base'}
          </Button>
        )}
      </div>
      {inheriting && (
        <p role="status" className="text-xs text-muted">
          <strong>Inherited from base</strong>: this version uses the base definition&apos;s{' '}
          {rules.length === 1 ? 'rule' : `${rules.length} rules`}
          {rules.length === 0 ? ' (none)' : ''}.
        </p>
      )}
      {rules.length === 0 && !inheriting && (
        <p className="text-xs text-muted">
          {override ? 'Cleared for this version: ' : 'No rules. '}
          {empty}
        </p>
      )}
      <ol className="flex flex-col gap-3">
        {rules.map((rule, index) => (
          <RuleRow
            key={index}
            id={`${id}.${index}`}
            index={index}
            count={rules.length}
            rule={rule}
            problems={problems[index] ?? {}}
            ruleHelp={ruleHelp}
            methods={methods}
            extra={extra}
            locked={inheriting || readOnly}
            onChange={(next) => set(replaceAt(rules, index, next))}
            onMove={(by) => set(moveBy(rules, index, by))}
            onRemove={() => set(removeAt(rules, index))}
          />
        ))}
      </ol>
      {!inheriting && !readOnly && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => set([...rules, newRule()])}
          >
            <PlusIcon /> Add rule
          </Button>
        </div>
      )}
    </div>
  );
}

function RuleRow<R extends AnyRule>({
  id,
  index,
  count,
  rule,
  problems,
  ruleHelp,
  methods,
  extra: Extra,
  locked,
  onChange,
  onMove,
  onRemove,
}: {
  id: string;
  index: number;
  count: number;
  rule: R;
  problems: RuleProblems;
  ruleHelp: RuleHelp;
  methods: boolean;
  extra: RuleExtra<R> | undefined;
  locked: boolean;
  onChange: (rule: R) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const ruleMethods = 'methods' in rule ? rule.methods : undefined;
  return (
    <li className="flex flex-col gap-3 rounded-md border border-border p-3">
      <fieldset disabled={locked} className="contents">
        <div className="flex items-start gap-2">
          <span className="mt-2 w-6 shrink-0 text-xs text-muted" title="Rules are tried in order">
            {index + 1}.
          </span>
          <div className="flex-1">
            <Field
              id={`${id}.pattern`}
              label="Pattern"
              help={ruleHelp.pattern}
              problem={problems.pattern}
            >
              <Input
                id={`${id}.pattern`}
                className="font-mono"
                spellCheck={false}
                value={rule.pattern}
                onChange={(event) => onChange({ ...rule, pattern: event.target.value })}
              />
            </Field>
          </div>
          {!locked && (
            <div className="mt-6 flex shrink-0 gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Move rule ${index + 1} up`}
                disabled={index === 0}
                onClick={() => onMove(-1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Move rule ${index + 1} down`}
                disabled={index === count - 1}
                onClick={() => onMove(1)}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove rule ${index + 1}`}
                onClick={onRemove}
              >
                <Trash2Icon />
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3 pl-8">
          {methods && (
            <MethodPicker
              id={`${id}.methods`}
              value={ruleMethods}
              help={ruleHelp.methods}
              problem={problems.methods}
              onChange={(next) => onChange(withMethods(rule, next))}
            />
          )}
          {Extra && (
            <Extra rule={rule} onChange={onChange} id={id} problems={problems} help={ruleHelp} />
          )}
        </div>
      </fieldset>
    </li>
  );
}

/**
 * The methods a rule applies to, as toggles; none on means every method.
 * A method g2way would refuse stays visible (and removable) until fixed.
 */
export function MethodPicker({
  id,
  value,
  help,
  problem,
  onChange,
}: {
  id: string;
  value: readonly string[] | undefined;
  help: string;
  problem?: string;
  onChange: (value: string[] | undefined) => void;
}) {
  const unknown = (value ?? []).filter((method) => !isTransformMethod(method));
  return (
    <div id={id} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">
        Methods <span className="font-normal text-muted">({describeMethods(value)})</span>
      </span>
      <div role="group" aria-label="Methods" className="flex flex-wrap gap-1">
        {[...TRANSFORM_METHODS, ...unknown].map((method) => {
          const on = hasMethod(value, method);
          return (
            <Button
              key={method}
              type="button"
              size="xs"
              variant={on ? 'default' : 'outline'}
              aria-pressed={on}
              className="font-mono"
              onClick={() => onChange(toggleMethod(value, method))}
            >
              {method}
            </Button>
          );
        })}
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      ) : (
        help && <p className="text-xs text-muted">{help}</p>
      )}
    </div>
  );
}

/**
 * Text for a map-valued setting (a mock's headers) that may not parse while
 * typed: shows the parse problem, applies only what parses.
 */
export function useParsedText<T>(
  value: T,
  format: (value: T) => string,
  parse: (text: string) => { ok: true; value: T } | { ok: false; problem: string },
) {
  const [text, setText] = useSyncedText(value, format, (t) => {
    const parsed = parse(t);
    return parsed.ok ? parsed.value : value;
  });
  const parsed = parse(text);
  return { text, setText, problem: parsed.ok ? undefined : parsed.problem };
}
