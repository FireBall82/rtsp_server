// Synthetic H.264 WHIP publisher and sustained RTSP decoder check; no camera.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func check(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	endpoint := flag.String("endpoint", "http://localhost:1984/api/webrtc?dst=camera", "WHIP endpoint (use an isolated test stream)")
	rtsp := flag.String("rtsp", "rtsp://localhost:8554/camera", "RTSP URL")
	ca := flag.String("ca", "", "Local HTTPS CA certificate")
	duration := flag.Int("seconds", 30, "Continuous decode duration")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*duration+40)*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 20 * time.Second}
	if *ca != "" {
		data, err := os.ReadFile(*ca)
		check(err)
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(data) {
			panic("Invalid CA")
		}
		client.Transport = &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}
	}
	setting := webrtc.SettingEngine{}
	setting.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeTCP4})
	setting.SetICETimeouts(10*time.Second, 20*time.Second, 2*time.Second)
	setting.SetIncludeLoopbackCandidate(true)
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(setting)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer pc.Close()
	connected := make(chan struct{}, 1)
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		fmt.Println("WHIP connection:", state)
		if state == webrtc.PeerConnectionStateConnected {
			select {
			case connected <- struct{}{}:
			default:
			}
		}
	})
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264,
		ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"}, "video", "synthetic")
	check(err)
	sender, err := pc.AddTrack(track)
	check(err)
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()
	gather := webrtc.GatheringCompletePromise(pc)
	offer, err := pc.CreateOffer(nil)
	check(err)
	check(pc.SetLocalDescription(offer))
	select {
	case <-gather:
	case <-ctx.Done():
		panic(ctx.Err())
	}
	request, err := http.NewRequestWithContext(ctx, "POST", *endpoint, strings.NewReader(pc.LocalDescription().SDP))
	check(err)
	request.Header.Set("Content-Type", "application/sdp")
	response, err := client.Do(request)
	check(err)
	answer, err := io.ReadAll(response.Body)
	response.Body.Close()
	check(err)
	if response.StatusCode != 201 {
		panic(fmt.Sprintf("WHIP %d: %s", response.StatusCode, answer))
	}
	base, err := url.Parse(*endpoint)
	check(err)
	resource, err := base.Parse(response.Header.Get("Location"))
	check(err)
	defer func() {
		req, _ := http.NewRequest("DELETE", resource.String(), nil)
		res, err := client.Do(req)
		if err == nil {
			res.Body.Close()
		}
	}()
	// Require reliable TCP, just as the site's reliable mode does.
	var lines []string
	for _, line := range strings.Split(string(answer), "\r\n") {
		if strings.HasPrefix(line, "a=candidate:") && !strings.Contains(strings.ToLower(line), " tcp ") {
			continue
		}
		lines = append(lines, line)
	}
	check(pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: strings.Join(lines, "\r\n")}))
	select {
	case <-connected:
	case <-ctx.Done():
		panic(ctx.Err())
	}
	socket, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	check(err)
	defer socket.Close()
	target := fmt.Sprintf("rtp://127.0.0.1:%d?pkt_size=1200", socket.LocalAddr().(*net.UDPAddr).Port)
	producer := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
		"-an", "-c:v", "libx264", "-profile:v", "baseline", "-level:v", "4.0", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-tune", "zerolatency",
		"-b:v", "6M", "-maxrate", "12M", "-bufsize", "12M", "-g", "30", "-x264-params", "repeat-headers=1", "-f", "rtp", target)
	producer.Stderr = os.Stderr
	check(producer.Start())
	defer func() { producer.Process.Kill(); producer.Wait() }()
	var sent atomic.Int64
	go func() {
		buf := make([]byte, 2048)
		for {
			n, _, err := socket.ReadFromUDP(buf)
			if err != nil {
				return
			}
			packet := &rtp.Packet{}
			if packet.Unmarshal(buf[:n]) == nil {
				if track.WriteRTP(packet) != nil {
					return
				}
				sent.Add(1)
			}
		}
	}()
	// Wait for media to reach go2rtc, not merely a connected transport.
	for sent.Load() < 100 {
		select {
		case <-ctx.Done():
			panic(ctx.Err())
		case <-time.After(20 * time.Millisecond):
		}
	}
	metadata, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-rtsp_transport", "tcp",
		"-show_entries", "stream=codec_name,width,height", "-of", "json", *rtsp).Output()
	check(err)
	var probe struct {
		Streams []struct {
			Codec  string `json:"codec_name"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
		} `json:"streams"`
	}
	check(json.Unmarshal(metadata, &probe))
	if len(probe.Streams) != 1 || probe.Streams[0].Codec != "h264" || probe.Streams[0].Width != 1920 || probe.Streams[0].Height != 1080 {
		panic(fmt.Sprintf("Unexpected RTSP metadata: %s", metadata))
	}
	decoder := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", *rtsp,
		"-t", fmt.Sprint(*duration), "-vf", "scale=64:36", "-fps_mode", "passthrough", "-f", "framemd5", "pipe:1")
	stdout, err := decoder.StdoutPipe()
	check(err)
	decoder.Stderr = os.Stderr
	check(decoder.Start())
	frames := 0
	distinct := map[string]bool{}
	scanner := bufio.NewScanner(stdout)
	started := time.Now()
	last := started
	maxGap := time.Duration(0)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}
		fields := strings.Split(line, ",")
		if len(fields) != 6 {
			continue
		}
		frames++
		distinct[strings.TrimSpace(fields[5])] = true
		now := time.Now()
		if frames > 1 && now.Sub(last) > maxGap {
			maxGap = now.Sub(last)
		}
		last = now
	}
	check(scanner.Err())
	check(decoder.Wait())
	if frames < *duration*25 || len(distinct) < *duration*20 || maxGap > 3*time.Second {
		panic(fmt.Sprintf("Frozen/slow stream: frames=%d distinct=%d maxGap=%s", frames, len(distinct), maxGap))
	}
	fmt.Printf("WHIP-to-RTSP stability passed: 1920x1080 H.264 over ICE TCP, %d decoded frames/%ds, %d distinct frames, longest decoded-frame gap %s\n", frames, *duration, len(distinct), maxGap.Round(time.Millisecond))
}
