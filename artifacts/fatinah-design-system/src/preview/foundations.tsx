import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { Guidelines } from './parts';

const CORE_SWATCHES = [
  { name: 'Primary', className: 'bg-primary' },
  { name: 'Secondary', className: 'bg-secondary' },
  { name: 'Accent', className: 'bg-accent' },
] as const;

const SUPPORTING_SWATCHES = [
  { name: 'Background', className: 'border bg-background' },
  { name: 'Foreground', className: 'bg-foreground' },
  { name: 'Muted', className: 'bg-muted' },
  { name: 'Destructive', className: 'bg-destructive' },
  { name: 'Border', className: 'bg-border' },
] as const;

const TYPE_SCALE = [
  { label: 'Display', className: 'text-4xl font-bold' },
  { label: 'Heading', className: 'text-2xl font-semibold' },
  { label: 'Body', className: 'text-base' },
  { label: 'Label', className: 'text-sm font-medium' },
  { label: 'Caption', className: 'text-sm text-muted-foreground' },
] as const;

const SPACING_SCALE = [
  { label: '4', className: 'w-4' },
  { label: '8', className: 'w-8' },
  { label: '12', className: 'w-12' },
  { label: '16', className: 'w-16' },
  { label: '24', className: 'w-24' },
] as const;

const FIRE_RAMP = [
  ['أصفر', '--fatinah-fire-yellow'],
  ['كهرماني', '--fatinah-fire-amber'],
  ['برتقالي', '--fatinah-fire-orange'],
  ['مرجاني', '--fatinah-fire-coral'],
  ['وردي', '--fatinah-fire-pink'],
  ['أرجواني', '--fatinah-fire-magenta'],
] as const;

const TEAM_COLORS = [
  ['النجوم', '--fatinah-teams-violet'],
  ['الصقور', '--fatinah-teams-teal'],
  ['الفرسان', '--fatinah-teams-peach'],
] as const;

function Swatch({
  name,
  className,
}: {
  name: string;
  className: string;
}) {
  return (
    <div className="space-y-2">
      <div className={`h-16 rounded-lg ${className}`} />
      <p className="text-sm font-medium">{name}</p>
    </div>
  );
}

export function OverviewPage() {
  return (
    <div className="space-y-4">
      <section className="rounded-xl border bg-card p-5 text-card-foreground">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Core palette
        </h2>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {CORE_SWATCHES.map((swatch) => (
            <Swatch key={swatch.name} {...swatch} />
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card p-5 text-card-foreground">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Typography
          </h2>
          <div className="mt-4 space-y-3">
            {TYPE_SCALE.map((entry) => (
              <p key={entry.label} className={entry.className}>
                {entry.label}
              </p>
            ))}
          </div>
        </section>

        <section className="rounded-xl border bg-card p-5 text-card-foreground">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            In use
          </h2>
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Create workspace</CardTitle>
              <CardDescription>
                Components composed from the tokens above.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="overview-name">Workspace name</Label>
                <Input id="overview-name" placeholder="Enter a name" />
              </div>
              <div className="flex items-center gap-2">
                <Switch defaultChecked id="overview-notify" />
                <Label htmlFor="overview-notify">Email notifications</Label>
                <Badge className="ml-auto">New</Badge>
              </div>
            </CardContent>
            <CardFooter className="gap-2">
              <Button>Save</Button>
              <Button variant="outline">Cancel</Button>
            </CardFooter>
          </Card>
        </section>
      </div>

      <section className="space-y-4 rounded-xl border bg-card p-5 text-card-foreground">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Components
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Badge>Badge</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
        </div>
      </section>
    </div>
  );
}

export function BrandPage() {
  return (
    <div className="space-y-6">
      <section
        className="overflow-hidden rounded-3xl border p-6 text-center shadow-2xl"
        style={{
          background: 'var(--fatinah-gradient-page)',
          borderColor: 'var(--fatinah-surface-line-strong)',
          boxShadow: 'var(--fatinah-shadow-elevated)',
        }}
      >
        <p className="text-sm font-medium text-[var(--fatinah-text-muted)]">
          لعبة الذكاء والفطنة الجماعية
        </p>
        <h2
          className="mt-3 text-7xl font-black"
          style={{
            background: 'var(--fatinah-gradient-brand)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          فَطِنة
        </h2>
        <p className="mt-3 text-lg text-[var(--fatinah-text-primary)]">
          مين الأفطن في المجلس؟
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section
          className="rounded-2xl border p-5"
          style={{
            background: 'var(--fatinah-surface-card)',
            borderColor: 'var(--fatinah-surface-line)',
          }}
        >
          <h2 className="font-bold">التدرّج الناري</h2>
          <p className="mt-1 text-sm text-[var(--fatinah-text-muted)]">
            يستخدم للشعار، الحماس، الأزرار الأساسية، ونقاط التركيز.
          </p>
          <div className="mt-5 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {FIRE_RAMP.map(([name, token]) => (
              <div key={token} className="space-y-2 text-center">
                <div
                  className="h-16 rounded-xl"
                  style={{ background: `var(${token})` }}
                />
                <p className="text-xs text-[var(--fatinah-text-muted)]">{name}</p>
              </div>
            ))}
          </div>
        </section>

        <section
          className="rounded-2xl border p-5"
          style={{
            background: 'var(--fatinah-surface-card)',
            borderColor: 'var(--fatinah-surface-line)',
          }}
        >
          <h2 className="font-bold">ألوان الفرق والحالات</h2>
          <p className="mt-1 text-sm text-[var(--fatinah-text-muted)]">
            ألوان مميزة للفرق، مع حالات نجاح وفشل واضحة أثناء الجولة.
          </p>
          <div className="mt-5 space-y-3">
            {TEAM_COLORS.map(([name, token]) => (
              <div
                key={token}
                className="flex items-center gap-3 rounded-xl p-3"
                style={{ background: 'var(--fatinah-surface-glass)' }}
              >
                <span
                  className="h-5 w-5 rounded-full shadow-lg"
                  style={{
                    background: `var(${token})`,
                    color: `var(${token})`,
                    boxShadow: '0 0 14px currentColor',
                  }}
                />
                <span className="font-bold">{name}</span>
              </div>
            ))}
            <div className="flex gap-3 pt-1 text-sm font-bold">
              <span className="rounded-full px-3 py-1" style={{ color: 'var(--fatinah-state-success)', background: 'rgba(61,220,132,.16)' }}>
                إجابة صحيحة
              </span>
              <span className="rounded-full px-3 py-1" style={{ color: 'var(--fatinah-state-error)', background: 'rgba(255,90,110,.16)' }}>
                إجابة خاطئة
              </span>
            </div>
          </div>
        </section>
      </div>

      <section
        className="rounded-2xl border p-5"
        style={{
          background: 'var(--fatinah-surface-glass)',
          borderColor: 'var(--fatinah-surface-line-strong)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <h2 className="font-bold">قواعد الاستخدام</h2>
        <div className="mt-4">
          <Guidelines
            items={[
              { kind: 'do', text: 'اجعل الخلفية الداكنة هي الأساس، واستخدم التدرّج الناري لتوجيه الانتباه.' },
              { kind: 'do', text: 'استخدم Tajawal مع اتجاه RTL ونصوص عربية واضحة ومباشرة.' },
              { kind: 'do', text: 'استخدم ألوان الفرق فقط لتمييز الملكية والنتيجة، لا كزينة عشوائية.' },
              { kind: 'dont', text: 'لا تستبدل الهوية الداكنة بخلفية بيضاء أو ألوان رمادية عامة.' },
              { kind: 'dont', text: 'لا تستخدم التدرّج الناري في كل عنصر؛ يجب أن يبقى نقطة تركيز.' },
            ]}
          />
        </div>
      </section>
    </div>
  );
}

export function ColorsPage() {
  return (
    <div className="space-y-8 rounded-xl border bg-card p-6 text-card-foreground">
      <section className="space-y-4">
        <div>
          <h2 className="font-semibold">Brand colors</h2>
          <p className="text-sm text-muted-foreground">
            The core roles used for emphasis, supporting actions, and accents.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {CORE_SWATCHES.map((swatch) => (
            <Swatch key={swatch.name} {...swatch} />
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="font-semibold">Semantic and surface colors</h2>
          <p className="text-sm text-muted-foreground">
            Roles for text, backgrounds, borders, muted content, and danger.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {SUPPORTING_SWATCHES.map((swatch) => (
            <Swatch key={swatch.name} {...swatch} />
          ))}
        </div>
      </section>
    </div>
  );
}

export function FontsPage() {
  return (
    <div className="space-y-8 rounded-xl border bg-card p-6 text-card-foreground">
      <section>
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Font family
        </h2>
        <p className="mt-4 text-4xl font-bold">The quick brown fox</p>
        <p className="mt-2 text-sm text-muted-foreground">
          The token font family is applied across this entire preview.
        </p>
      </section>

      <section className="space-y-4 border-t pt-6">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Type scale
        </h2>
        {TYPE_SCALE.map((entry) => (
          <div key={entry.label} className="grid gap-2 sm:grid-cols-[88px_1fr]">
            <span className="pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {entry.label}
            </span>
            <p className={entry.className}>Build products people understand.</p>
          </div>
        ))}
      </section>
    </div>
  );
}

export function LayoutPage() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl border bg-card p-6 text-card-foreground">
        <h2 className="font-semibold">Spacing</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The spacing scale, derived from the base spacing token.
        </p>
        <div className="mt-6 space-y-4">
          {SPACING_SCALE.map((space) => (
            <div key={space.label} className="flex items-center gap-4">
              <span className="w-8 text-xs text-muted-foreground">
                {space.label}
              </span>
              <div className={`h-3 rounded-full bg-primary ${space.className}`} />
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border bg-card p-6 text-card-foreground">
        <h2 className="font-semibold">Radius</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Corner treatments derive from the base radius token.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-4">
          {[
            { label: 'Small', className: 'rounded-sm' },
            { label: 'Medium', className: 'rounded-md' },
            { label: 'Large', className: 'rounded-lg' },
            { label: 'Extra large', className: 'rounded-xl' },
          ].map((radius) => (
            <div
              key={radius.label}
              className={`flex h-24 items-end border bg-muted p-3 ${radius.className}`}
            >
              <span className="text-xs font-medium">{radius.label}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
