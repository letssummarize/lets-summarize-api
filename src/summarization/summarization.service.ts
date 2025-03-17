import {
  BadRequestException,
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import OpenAI from 'openai';
import { unlinkSync, existsSync, mkdirSync, createReadStream } from 'fs';
import { basename, extname, join } from 'path';
import { create } from 'youtube-dl-exec';
import { config } from 'dotenv';
import { SummarizeVideoDto } from './dto/summarize-video.dto';
import { extractTextFromPdf, extractTextFromDocx } from 'src/utils/files.util';
import { SummarizationOptions } from './interfaces/summarization-options.interface';
import { SummarizationOptionsDto } from './dto/summarization-options.dto';
import {
  cleanupFiles,
  extractPrefixFromPath,
  extractVideoId,
  generateRandomSuffix,
  getApiKey,
  getSummarizationOptions,
  isValidYouTubeUrl,
} from 'src/utils/summarization.util';
import { YoutubeTranscript } from 'youtube-transcript';
config();

@Injectable()
export class SummarizationService {
  // Default OpenAI API key for our service. Users need to provide their own API key when integrating with our service.
  private readonly defaultApiKey = process.env.OPENAI_API_KEY;

  private readonly ytdlp = create(
    process.env.PATH_TO_YT_DLP || 'add-your-path-here',
  ); // Using custom binary

  private readonly DOWNLOAD_DIR = join(process.cwd(), 'downloads');
  private readonly AUDIO_FORMAT = 'mp3';
  private readonly MAX_TOKENS = 15000;

  constructor() {
    if (!existsSync(this.DOWNLOAD_DIR)) {
      mkdirSync(this.DOWNLOAD_DIR, { recursive: true });
    }
  }

  /**
   * Summarizes a YouTube video using either direct transcript fetching or audio-based transcription.
   * @param content - Contains the videoUrl to be summarized
   * @param optionsDto - User-specified summarization options (length, format, etc.)
   * @param userApiKey - Optional user-provided OpenAI API key (used when users integrate their own applications with our service)
   * @returns An object containing the transcript and summary of the video
   * @throws BadRequestException if the YouTube URL is invalid or if summarization fails
   */
  async summarizeYouTubeVideo(
    content: SummarizeVideoDto,
    optionsDto?: SummarizationOptionsDto,
    userApiKey?: string,
  ) {
    const { videoUrl } = content;

    if (!isValidYouTubeUrl(videoUrl)) {
      throw new BadRequestException('Invalid YouTube URL');
    }

    const options = getSummarizationOptions(optionsDto);

    try {
      console.log('Fetching transcript for video:', videoUrl);

      try {
        const videoId = extractVideoId(videoUrl);
        if (!videoId) {
          return this.summarizeYouTubeVideoUsingAudio(
            videoUrl,
            options,
            userApiKey,
          );
        }
        const transcript = await this.fetchYouTubeTranscript(videoId);
        const summary = await this.summarizeText(
          transcript,
          options,
          userApiKey,
        );
        return { transcript, summary };
      } catch (transcriptError) {
        return this.summarizeYouTubeVideoUsingAudio(
          videoUrl,
          options,
          userApiKey,
        );
      }
    } catch (error) {
      console.error('Error:', error.message);
      throw new BadRequestException(error.message);
    }
  }

  private async fetchYouTubeTranscript(videoId: string): Promise<string> {
    try {
      const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
      const fullTranscript = transcriptItems
        .map((item) => item.text.trim())
        .filter((text) => text.length > 0)
        .join(' ');

      const words = fullTranscript.split(' ');
      const safeLength = Math.floor(this.MAX_TOKENS / 4);
      return words.slice(0, safeLength).join(' ');
    } catch (error) {
      throw new Error(
        `Could not fetch transcript from YouTube: ${error.message}`,
      );
    }
  }

  private async summarizeYouTubeVideoUsingAudio(
    videoUrl: string,
    options: SummarizationOptions,
    userApiKey?: string,
  ) {
    try {
      console.log(
        'Direct transcript fetch failed, falling back to audio download:',
      );
      const audioPath = await this.downloadAudio(videoUrl);
      const transcript = await this.transcribeAudio(audioPath, userApiKey);
      const summary = await this.summarizeText(transcript, options, userApiKey);
      const prefix = extractPrefixFromPath(audioPath);
      cleanupFiles(this.DOWNLOAD_DIR, prefix);

      return { transcript, summary };
    } catch (error) {
      throw new Error(
        `Failed to summarize video using audio: ${error.message}`,
      );
    }
  }

  /**
   * Summarizes an uploaded file.
   * @param file - The uploaded file (PDF, DOCX, or TXT).
   * @param optionsDto - User-specified summarization options.
   * @param userApiKey - Optional user-provided OpenAI API key (used when users integrate their own applications with our service).
   * @returns The summarized text of the file's content.
   */
  async summarizeFile(
    file: Express.Multer.File,
    optionsDto?: SummarizationOptionsDto,
    userApiKey?: string,
  ): Promise<string> {
    console.log(`Processing file: ${file.originalname} (${file.mimetype})`);
    const options = getSummarizationOptions(optionsDto);

    // Extract text based on file type
    const text = await this.extractTextFromFile(file);

    if (!text.trim()) {
      throw new BadRequestException('Could not extract text from the file.');
    }

    // Summarize the extracted text
    return this.summarizeText(text, options, userApiKey);
  }

  /**
   * Downloads audio from a YouTube video using yt-dlp-exec.
   * @param videoUrl - The URL of the YouTube video.
   * @returns The file path of the downloaded audio.
   * @throws Error if the audio download fails.
   */
  async downloadAudio(videoUrl: string): Promise<string> {
    const prefix = generateRandomSuffix();
    const audioPath = join(this.DOWNLOAD_DIR, `${prefix}.${this.AUDIO_FORMAT}`);
    const startTime = new Date();

    try {
      console.log(`Downloading audio... Started at ${startTime.toISOString()}`);
      await this.ytdlp(videoUrl, {
        extractAudio: true,
        audioFormat: this.AUDIO_FORMAT,
        output: audioPath,
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
      });

      const endTime = new Date();
      const duration = (endTime.getTime() - startTime.getTime()) / 1000;
      console.log(
        `Downloaded audio: ${audioPath}. Finished at ${endTime.toISOString()}. Time taken: ${duration} seconds`,
      );

      if (!existsSync(audioPath)) {
        throw new Error('Audio file was not created.');
      }

      return audioPath;
    } catch (error) {
      const failTime = new Date();
      const duration = (failTime.getTime() - startTime.getTime()) / 1000;
      console.error(
        `Error downloading audio: ${error}. Finished at ${failTime.toISOString()}. Time taken: ${duration} seconds`,
      );
      throw new Error('Failed to download audio');
    }
  }

  /**
   * Transcribes an audio file using OpenAI's Whisper model.
   * @param audioPath - Path to the downloaded audio file.
   * @param userApiKey - Optional user-provided OpenAI API key (used when users integrate their own applications with our service).
   * @returns The transcribed text from the audio file.
   */
  private async transcribeAudio(
    audioPath: string,
    userApiKey?: string,
  ): Promise<string> {
    const apiKey = getApiKey(userApiKey, this.defaultApiKey);
    const openaiClient = new OpenAI({ apiKey });
    const startTime = new Date();

    try {
      console.log(
        `Transcribing audio... Started at ${startTime.toISOString()}`,
      );
      const fileStream = createReadStream(audioPath);

      const response = await openaiClient.audio.transcriptions.create({
        file: fileStream,
        model: 'whisper-1',
        language: 'en',
        response_format: 'json',
      });

      const endTime = new Date();
      const duration = (endTime.getTime() - startTime.getTime()) / 1000;
      console.log(
        `Transcription finished at ${endTime.toISOString()}. Time taken: ${duration} seconds`,
      );

      return response.text;
    } catch (error) {
      const failTime = new Date();
      const duration = (failTime.getTime() - startTime.getTime()) / 1000;
      console.error(
        `Transcription failed at ${failTime.toISOString()}. Time taken: ${duration} seconds. Error: ${error.message}`,
      );
      throw new Error(`Failed to transcribe audio: ${error.message}`);
    }
  }

  /**
   * Generates a summary for the given text using GPT-4o.
   * @param text - The text to summarize.
   * @param options - Summarization preferences (length, format, etc.).
   * @param userApiKey - Optional user-provided OpenAI API key (used when users integrate their own applications with our service).
   * @returns The summarized version of the input text.
   */
  async summarizeText(
    text: string,
    options?: SummarizationOptions,
    userApiKey?: string,
  ): Promise<string> {
    const apiKey = getApiKey(userApiKey, this.defaultApiKey);
    const openaiClient = new OpenAI({ apiKey });
    const startTime = new Date();

    try {
      console.log(`Summarizing text... Started at ${startTime.toISOString()}`);
      const { length, format, listen } = getSummarizationOptions(options);
      const prompt = `Summarize the following text in a ${length} format, in ${format} style:\n\n${text}`;
      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content:
              'You are a summarization expert who extracts key details from long texts.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 150,
      });

      const endTime = new Date();
      const duration = (endTime.getTime() - startTime.getTime()) / 1000;
      console.log(
        `Summarization finished at ${endTime.toISOString()}. Time taken: ${duration} seconds`,
      );

      return (
        response.choices[0]?.message?.content || 'Could not generate a summary.'
      );
    } catch (error) {
      const failTime = new Date();
      const duration = (failTime.getTime() - startTime.getTime()) / 1000;
      console.error(
        `Summarization failed at ${failTime.toISOString()}. Time taken: ${duration} seconds. Error: ${error.message}`,
      );
      throw new Error(`Failed to summarize text: ${error.message}`);
    }
  }

  /**
   * Extracts text from different file formats.
   * @param file - The uploaded file (PDF, DOCX, or TXT).
   * @returns The extracted text from the file.
   * @throws UnsupportedMediaTypeException if the file format is not supported.
   */
  private async extractTextFromFile(
    file: Express.Multer.File,
  ): Promise<string> {
    const ext = extname(file.originalname).toLowerCase();

    switch (ext) {
      case '.txt':
        return file.buffer.toString('utf-8'); // Read plain text file

      case '.pdf':
        return extractTextFromPdf(file);

      case '.docx':
        return extractTextFromDocx(file);

      default:
        throw new UnsupportedMediaTypeException(
          'Unsupported file format. Only PDF, TXT, and DOCX are allowed.',
        );
    }
  }
}
