using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Windows.Forms;

internal static class EditFlowUpdateHelper
{
    [STAThread]
    private static void Main(string[] args)
    {
        var errorPath = args.Length > 2 ? args[2] : Path.Combine(Path.GetTempPath(), "editflow-update-helper-error.log");
        try
        {
            if (args.Length < 3) throw new ArgumentException("Marker, ready and error paths are required.");
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new UpdateWindow(args[0], args[1], errorPath, args.Length > 3 ? args[3] : string.Empty));
        }
        catch (Exception error)
        {
            try
            {
                var directory = Path.GetDirectoryName(errorPath);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                File.WriteAllText(errorPath, error.ToString());
            }
            catch { }
            Environment.ExitCode = 1;
        }
    }

    private sealed class UpdateWindow : Form
    {
        private readonly string markerPath;
        private readonly string readyPath;
        private readonly DateTime startedAt = DateTime.UtcNow;
        private readonly Timer timer = new Timer();
        private readonly SpinnerControl spinner = new SpinnerControl();
        private readonly Panel[] dots = new Panel[3];
        private int tick;

        internal UpdateWindow(string markerPath, string readyPath, string errorPath, string targetVersion)
        {
            this.markerPath = markerPath;
            this.readyPath = readyPath;
            Text = "EditFlow";
            ClientSize = new Size(390, 168);
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = ColorTranslator.FromHtml("#171623");
            Opacity = 0.98;
            Region = RoundedRegion(ClientRectangle, 24);

            var iconPanel = new RoundedPanel(18)
            {
                Location = new Point(24, 55),
                Size = new Size(58, 58),
                BackColor = ColorTranslator.FromHtml("#675DCE")
            };
            spinner.Location = new Point(14, 14);
            spinner.Size = new Size(30, 30);
            iconPanel.Controls.Add(spinner);

            var title = new Label
            {
                Location = new Point(100, 44),
                Size = new Size(260, 26),
                Font = new Font("Segoe UI", 12f, FontStyle.Bold),
                ForeColor = Color.White,
                Text = "Aplicando atualização"
            };

            var status = new Label
            {
                Location = new Point(100, 73),
                Size = new Size(260, 39),
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = ColorTranslator.FromHtml("#C0BFD3"),
                Text = string.IsNullOrWhiteSpace(targetVersion)
                    ? "O EditFlow será reiniciado automaticamente. Não desligue o computador."
                    : string.Format("Instalando a versão {0}. O EditFlow abrirá novamente em instantes.", targetVersion)
            };

            for (var index = 0; index < dots.Length; index++)
            {
                dots[index] = new RoundedPanel(2)
                {
                    Location = new Point(100 + index * 11, 120),
                    Size = new Size(5, 5),
                    BackColor = ColorTranslator.FromHtml(index == 0 ? "#BDB6FF" : "#554F73")
                };
                Controls.Add(dots[index]);
            }

            Controls.Add(iconPanel);
            Controls.Add(title);
            Controls.Add(status);

            timer.Interval = 45;
            timer.Tick += OnTimerTick;
            Shown += OnWindowShown;
            FormClosed += delegate { timer.Dispose(); };
        }

        protected override void OnPaint(PaintEventArgs paintEvent)
        {
            base.OnPaint(paintEvent);
            paintEvent.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var pen = new Pen(Color.FromArgb(52, 255, 255, 255), 1f))
            {
                paintEvent.Graphics.DrawPath(pen, RoundedPath(new Rectangle(1, 1, Width - 3, Height - 3), 23));
            }
        }

        private void OnWindowShown(object sender, EventArgs eventArgs)
        {
            File.WriteAllText(readyPath, DateTime.Now.ToString("O"));
            Activate();
            timer.Start();
        }

        private void OnTimerTick(object sender, EventArgs eventArgs)
        {
            spinner.Angle = (spinner.Angle + 11) % 360;
            spinner.Invalidate();
            tick = (tick + 1) % 60;
            var phase = (tick / 10) % 3;
            for (var index = 0; index < dots.Length; index++)
                dots[index].BackColor = ColorTranslator.FromHtml(index == phase ? "#BDB6FF" : "#554F73");

            if (!File.Exists(markerPath) || DateTime.UtcNow.Subtract(startedAt).TotalMinutes >= 3)
            {
                timer.Stop();
                Close();
            }
        }
    }

    private sealed class SpinnerControl : Control
    {
        internal int Angle { get; set; }

        internal SpinnerControl()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }

        protected override void OnPaint(PaintEventArgs paintEvent)
        {
            paintEvent.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var track = new Pen(Color.FromArgb(85, 255, 255, 255), 3f))
            using (var accent = new Pen(Color.White, 3f))
            {
                paintEvent.Graphics.DrawArc(track, 4, 4, 21, 21, 0, 360);
                paintEvent.Graphics.DrawArc(accent, 4, 4, 21, 21, Angle, 255);
            }
        }
    }

    private sealed class RoundedPanel : Panel
    {
        private readonly int radius;

        internal RoundedPanel(int radius)
        {
            this.radius = radius;
        }

        protected override void OnSizeChanged(EventArgs eventArgs)
        {
            base.OnSizeChanged(eventArgs);
            if (Width > 0 && Height > 0) Region = RoundedRegion(ClientRectangle, radius);
        }
    }

    private static Region RoundedRegion(Rectangle bounds, int radius)
    {
        using (var path = RoundedPath(bounds, radius)) return new Region(path);
    }

    private static GraphicsPath RoundedPath(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var diameter = radius * 2;
        var arc = new Rectangle(bounds.Location, new Size(diameter, diameter));
        path.AddArc(arc, 180, 90);
        arc.X = bounds.Right - diameter;
        path.AddArc(arc, 270, 90);
        arc.Y = bounds.Bottom - diameter;
        path.AddArc(arc, 0, 90);
        arc.X = bounds.Left;
        path.AddArc(arc, 90, 90);
        path.CloseFigure();
        return path;
    }
}
