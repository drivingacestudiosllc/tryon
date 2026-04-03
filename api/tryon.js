// ═══════════════════════════════════════════════════════════
//  Shoe Try-On Backend  —  api/tryon.js
//  Deploy on Vercel (serverless) or Render (Node web service)
//
//  Environment variables required:
//    FAL_KEY   →  your fal.ai API key (from fal.ai/dashboard)
// ═══════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  // ── CORS headers (allow your Squarespace domain + localhost) ──
  const allowedOrigins = [
    'https://www.littlestarshipacademy.store',  // ← replace with your domain
    'https://littlestarshipacademy.store',       // ← replace with your domain
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Validate API key ──
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) {
    console.error('FAL_KEY environment variable not set');
    return res.status(500).json({ error: 'Server misconfiguration: missing FAL_KEY' });
  }

  // ── Parse request body ──
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { user_image_b64, shoe_image_src, shoe_name, shoe_brand } = body;

  if (!user_image_b64) return res.status(400).json({ error: 'Missing user_image_b64' });
  if (!shoe_image_src) return res.status(400).json({ error: 'Missing shoe_image_src' });

  try {
    // ── Upload user image to fal.ai storage ──
    console.log('Uploading user image to fal.ai storage…');

    // Convert base64 data URI to a Blob-compatible buffer
    const base64Data = user_image_b64.split(',')[1];
    const mimeMatch = user_image_b64.match(/data:([^;]+);/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Upload to fal storage
    const uploadResponse = await fetch('https://fal.run/fal-ai/storage/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': mimeType,
      },
      body: imageBuffer,
    });

    if (!uploadResponse.ok) {
      const uploadErr = await uploadResponse.text();
      throw new Error(`fal.ai upload failed: ${uploadErr}`);
    }

    const { url: userImageUrl } = await uploadResponse.json();
    console.log('User image uploaded:', userImageUrl);

    // ── Handle shoe image ──
    // If it's a data URI (our SVG placeholders), upload it too.
    // If it's already an https:// URL, use it directly.
    let shoeImageUrl = shoe_image_src;

    if (shoe_image_src.startsWith('data:')) {
      const shoeBase64 = shoe_image_src.split(',')[1];
      const shoeMimeMatch = shoe_image_src.match(/data:([^;]+);/);
      const shoeMime = shoeMimeMatch ? shoeMimeMatch[1] : 'image/png';
      const shoeBuffer = Buffer.from(shoeBase64, 'base64');

      const shoeUpload = await fetch('https://fal.run/fal-ai/storage/upload', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${FAL_KEY}`,
          'Content-Type': shoeMime,
        },
        body: shoeBuffer,
      });

      if (!shoeUpload.ok) {
        const shoeErr = await shoeUpload.text();
        throw new Error(`fal.ai shoe upload failed: ${shoeErr}`);
      }
      const shoeData = await shoeUpload.json();
      shoeImageUrl = shoeData.url;
      console.log('Shoe image uploaded:', shoeImageUrl);
    }

    // ── Call fal.ai IDM-VTON (virtual try-on) ──
    // IDM-VTON supports clothing/shoe try-on.
    // Prompt guides the model to focus on shoe replacement.
    const prompt = `A person wearing ${shoe_name} ${shoe_brand} shoes, photorealistic, high quality, natural lighting, same pose and background as original photo`;

    console.log('Calling fal.ai IDM-VTON…');

    const falResponse = await fetch('https://fal.run/fal-ai/idm-vton', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        human_image_url: userImageUrl,
        garment_image_url: shoeImageUrl,
        description: prompt,
        with_parsing: true,
      }),
    });

    if (!falResponse.ok) {
      const falErr = await falResponse.text();
      console.error('fal.ai error:', falErr);

      // Fallback: try flux-pro inpainting if VTON fails
      console.log('IDM-VTON failed, trying flux inpainting fallback…');
      return await fluxInpaintFallback(res, FAL_KEY, userImageUrl, shoe_name, shoe_brand, prompt);
    }

    const falData = await falResponse.json();
    console.log('fal.ai response keys:', Object.keys(falData));

    // fal.ai returns image as URL in images[0].url or image.url
    const resultImageUrl =
      falData?.images?.[0]?.url ||
      falData?.image?.url ||
      falData?.output?.image ||
      null;

    if (!resultImageUrl) {
      console.error('Unexpected fal.ai response shape:', JSON.stringify(falData).slice(0, 500));
      throw new Error('Could not find result image in fal.ai response');
    }

    console.log('Success! Result image:', resultImageUrl);
    return res.status(200).json({ result_image: resultImageUrl });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────
//  FALLBACK: flux-pro inpainting
//  Used if IDM-VTON is unavailable or returns an error.
// ─────────────────────────────────────────────────────────────
async function fluxInpaintFallback(res, FAL_KEY, userImageUrl, shoe_name, shoe_brand, prompt) {
  try {
    const inpaintResponse = await fetch('https://fal.run/fal-ai/flux-pro/v1/fill', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_url: userImageUrl,
        prompt: prompt,
        // Without an explicit mask, flux-fill will edit the most relevant region
        num_inference_steps: 28,
        guidance_scale: 3.5,
      }),
    });

    if (!inpaintResponse.ok) {
      const err = await inpaintResponse.text();
      throw new Error(`Fallback also failed: ${err}`);
    }

    const inpaintData = await inpaintResponse.json();
    const resultUrl =
      inpaintData?.images?.[0]?.url ||
      inpaintData?.image?.url ||
      null;

    if (!resultUrl) throw new Error('No result from fallback model');

    return res.status(200).json({ result_image: resultUrl });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
